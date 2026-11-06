import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { stringToHex } from 'viem';

// Only the SDK transport boundary is substituted. Owner signatures and the application decoder are real fixture checks.
// The ephemeral keys below are test identities. No wallet, network, chain write or live receipt is involved.
const sdk = vi.hoisted(() => ({ chain: vi.fn(), entity: vi.fn(), head: vi.fn(), fetch: vi.fn(), queries: [] as unknown[] }));
vi.mock('@arkiv-network/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@arkiv-network/sdk')>(),
  createPublicClient: () => ({ getChainId: sdk.chain, getEntity: sdk.entity, getBlockNumber: sdk.head,
    select: () => {
      const query = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), ownedBy: vi.fn(), createdBy: vi.fn(), fetch: sdk.fetch };
      for (const method of [query.from, query.where, query.orderBy, query.limit, query.ownedBy, query.createdBy]) method.mockReturnValue(query);
      sdk.queries.push(query);
      return query;
    } }),
}));

import { ARKIV_CHAIN_ID, canonicalIntent, createArkivAdapter, intentSigningMessage, type PublicIntent } from '../packages/arkiv/src';

const owner = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const now = Date.parse('2026-11-06T06:00:00.000Z');
const entityKey = `0x${'a'.repeat(64)}`;
const initial: PublicIntent = { intentId: 'explicit-adapter-fixture', ensAgentRef: 'agent.fixture.eth', goal: 'collaborator',
  tags: ['devrel'], summary: 'Explicit fictional developer advocacy collaborator fixture.', visibility: 'public', optIn: true, status: 'active', schemaVersion: 2,
  owner: owner.address, version: 1, policyVersion: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), demoOrigin: true,
  semantics: { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborator', direction: 'collaborating', directionEvidence: 'collaborator',
    canonicalRole: { value: 'developer advocate', sourceQuote: 'developer advocacy' }, topics: [], offers: [], requirements: [], clarificationQuestions: [] } };

async function row(changes: Partial<PublicIntent> = {}, key = entityKey) {
  const intent = canonicalIntent({ ...initial, ...changes });
  const signature = await owner.signMessage({ message: intentSigningMessage(intent) });
  const values: Record<string, unknown> = { $key: key, $owner: owner.address, $creator: owner.address, $expiresAt: 2000n,
    $creationFlags: { readonly: true, permissionlessExtension: false }, envelope: { type: 'bytes', value: stringToHex(JSON.stringify({ intent, signature })) } };
  const indexed: Record<string, string | bigint | boolean> = { intentId: intent.intentId, ensAgentRef: intent.ensAgentRef, goal: intent.goal,
    visibility: intent.visibility, optIn: intent.optIn, schemaVersion: 2n, status: intent.status, direction: intent.semantics.direction,
    category: intent.semantics.category, canonicalRole: 'developer relations', version: BigInt(intent.version), policyVersion: BigInt(intent.policyVersion),
    createdAt: BigInt(Date.parse(intent.createdAt)), expiresAt: BigInt(Date.parse(intent.expiresAt)), demoOrigin: intent.demoOrigin };
  for (const [field, value] of Object.entries(indexed)) values[field] = { type: typeof value === 'bigint' ? 'u64' : typeof value === 'boolean' ? 'bool' : 'str', value };
  values.owner = { type: 'addr', value: intent.owner };
  for (let index = 0; index < 8; index++) values[`tag${index}`] = { type: 'str', value: intent.tags[index] || '' };
  return values;
}
function page(entities: Record<string, unknown>[]) { return { entities, blockNumber: 1000n, skipped: 0 }; }
function adapter() { return createArkivAdapter({ accessKey: 'explicit-local-sdk-transport-fixture', now: () => now }); }

beforeEach(() => {
  sdk.chain.mockReset().mockResolvedValue(ARKIV_CHAIN_ID);
  sdk.head.mockReset().mockResolvedValue(1000n);
  sdk.entity.mockReset(); sdk.fetch.mockReset(); sdk.queries.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access from a test fixture'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Arkiv adapter freshness with explicit SDK transport fixtures', () => {
  it('rechecks the newest owner-created version on every protected read', async () => {
    const current = await row(); sdk.entity.mockResolvedValue(current); sdk.fetch.mockResolvedValue(page([current]));
    const service = adapter();
    expect((await service.readActive(entityKey)).intent.version).toBe(1);
    expect((await service.readActive(entityKey)).intent.version).toBe(1);
    expect(sdk.entity).toHaveBeenCalledTimes(2); expect(sdk.chain).toHaveBeenCalledTimes(2);
    expect(sdk.fetch).toHaveBeenCalledTimes(2);
    for (const query of sdk.queries as { ownedBy: ReturnType<typeof vi.fn>; createdBy: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> }[]) {
      expect(query.ownedBy).toHaveBeenCalledWith(owner.address);
      expect(query.createdBy).toHaveBeenCalledWith(owner.address);
      expect(query.limit).toHaveBeenCalledWith(2);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['edited', 'closed', 'expired', 'conflicting', 'copied-creator', 'forged-index'])('rejects a protected read after a %s newest record', async state => {
    sdk.entity.mockResolvedValue(await row());
    let newest: Record<string, unknown>;
    if (state === 'closed') newest = await row({ version: 2, status: 'closed', optIn: false });
    else if (state === 'expired') newest = await row({ version: 2, createdAt: new Date(now - 7200000).toISOString(), expiresAt: new Date(now - 3600000).toISOString() });
    else if (state === 'conflicting') newest = await row({ summary: 'Conflicting owner signed content at the same version.' });
    else newest = await row({ version: 2, summary: 'Edited fixture.' });
    if (state === 'copied-creator') newest.$creator = outsider.address;
    if (state === 'forged-index') newest.direction = { type: 'str', value: 'hiring' };
    sdk.fetch.mockResolvedValue(page([newest]));
    await expect(adapter().readActive(entityKey)).rejects.toThrow('unavailable, changed, closed, or expired');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['wrong-chain', 'entity-rpc', 'latest-rpc', 'missing-latest'])('denies a protected read on %s without a cached publication fallback', async failure => {
    const current = await row(); sdk.entity.mockResolvedValue(current); sdk.fetch.mockResolvedValue(page([current]));
    const service = adapter(); await service.readActive(entityKey);
    if (failure === 'wrong-chain') sdk.chain.mockResolvedValue(1);
    if (failure === 'entity-rpc') sdk.entity.mockRejectedValue(new Error('Explicit fixture RPC failure'));
    if (failure === 'latest-rpc') sdk.fetch.mockRejectedValue(new Error('Explicit fixture RPC failure'));
    if (failure === 'missing-latest') sdk.fetch.mockResolvedValue(page([]));
    await expect(service.readActive(entityKey)).rejects.toThrow('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['edited', 'closed', 'expired'])('suppresses an older query hit when the newest record is %s', async state => {
    const current = await row();
    const changes: Partial<PublicIntent> = state === 'closed' ? { version: 2, status: 'closed', optIn: false }
      : state === 'expired' ? { version: 2, createdAt: new Date(now - 7200000).toISOString(), expiresAt: new Date(now - 3600000).toISOString() }
      : { version: 2, tags: ['other-topic'], semantics: { ...initial.semantics, direction: 'hiring' } };
    sdk.fetch.mockResolvedValueOnce(page([current])).mockResolvedValueOnce(page([await row(changes)]));
    const result = await adapter().discover({ goal: 'collaborator', tags: ['devrel'], directions: ['collaborating'], includeDemo: true });
    expect(result.candidates).toEqual([]);
    expect(result.observedBlocks).toHaveLength(2);
    expect(sdk.fetch).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
