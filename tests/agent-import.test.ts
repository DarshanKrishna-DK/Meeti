import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, type Address, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Local RPC fixtures exercise the actual ENS authority verifier. They are not live provider receipts.
const transport = vi.hoisted(() => ({ client: undefined as unknown, checks: vi.fn() }));
vi.mock('../packages/ens', async importOriginal => {
  const original = await importOriginal<typeof import('../packages/ens')>();
  return { ...original, createEnsAuthorityProvider: (options: Parameters<typeof original.createEnsAuthorityProvider>[0]) => {
    const provider = original.createEnsAuthorityProvider({ ...options, client: transport.client as PublicClient });
    return { ...provider, checkAuthority: (request: Parameters<typeof provider.checkAuthority>[0]) => {
      transport.checks(request);
      return provider.checkAuthority(request);
    } };
  } };
});

import { route } from '../packages/server/router';
import { agent, closeDatabase, db, profile, saveAgent } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { decodeInlinePolicyUri, encodeInlinePolicyUri, ENS_DEPLOYMENT, inlinePolicyDigest, STATUS_KEY, textResource, type EnsInlinePolicy, type EnsPublicPolicy } from '../packages/ens';
import type { Agent } from '../packages/shared/src';

const origin = 'http://127.0.0.1:3198';
const ensName = 'agent.owner-fixture.eth';
const delegate = `0x${'22'.repeat(20)}` as Address;
const registry = `0x${'33'.repeat(20)}` as Address;
const resolver = `0x${'44'.repeat(20)}` as Address;
const outsider = `0x${'55'.repeat(20)}` as Address;
let directory: string;
async function call(path: string, body?: unknown, cookie?: string, requestOrigin = origin) {
  return route(new Request(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
}
async function signIn() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const challenge = await call('auth/wallet/challenge', { address: wallet.address, chainId: 1 });
  expect(challenge.status).toBe(200);
  const { data } = await challenge.json();
  const flow = challenge.headers.getSetCookie().find(value => value.startsWith('meeti_wallet_flow='))!.split(';')[0];
  const signed = await call('auth/wallet/verify', { id: data.id, signature: await wallet.signMessage({ message: data.message }) }, flow);
  expect(signed.status).toBe(200);
  const account = (await signed.json()).data as { id: string };
  return { id: account.id, wallet, cookie: signed.headers.getSetCookie().find(value => value.startsWith('meeti_session='))!.split(';')[0] };
}
function fixture(owner: Address) {
  const now = Date.now();
  const inline: EnsInlinePolicy = { version: 7, purpose: 'mentor', allowedFields: ['offering', 'headline'], allowedActions: ['publish', 'discover'], expiresAt: new Date(now + 3600000).toISOString(), paused: false };
  const publicPolicy: EnsPublicPolicy = { version: '7', ensName, owner, delegate, digest: inlinePolicyDigest(inline), uri: encodeInlinePolicyUri(inline), expiresAt: Math.floor(Date.parse(inline.expiresAt) / 1000), actions: ['publish', 'discover', 'update-status'], resolverScope: 'dedicated-agent' };
  const state = { owner, granted: true, chain: 11155111, headAge: 0, block: 100n, publicPolicy };
  const reads = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
    if (functionName === 'ROOT_REGISTRY') return ENS_DEPLOYMENT.rootRegistry;
    if (functionName === 'isENSv2') return true;
    if (functionName === 'getSubregistry') return address === ENS_DEPLOYMENT.rootRegistry ? ENS_DEPLOYMENT.ethRegistry : registry;
    if (functionName === 'getState') return { status: 2, latestOwner: state.owner, expiry: BigInt(Math.floor(now / 1000) + 7200), tokenId: 30n, resource: 31n };
    if (functionName === 'getResolver' || functionName === 'predictProxyAddress') return resolver;
    if (functionName === 'verifyContract') return args[0] === registry ? ENS_DEPLOYMENT.registryImplementation : ENS_DEPLOYMENT.resolverImplementation;
    if (functionName === 'roles') {
      if (String(args[1]).toLowerCase() === owner.toLowerCase()) return BigInt(`0x${'1'.repeat(64)}`);
      if (address === resolver && args[0] === textResource(STATUS_KEY)) return state.granted ? 16n : 0n;
      return 0n;
    }
    if (functionName === 'roleCount') return args[0] === 0n ? BigInt(`0x${'1'.repeat(64)}`) : 0n;
    if (functionName === 'hasRoles') return state.granted;
    if (functionName === 'getRecordId') return 1n;
    if (functionName === 'resolve') return encodeAbiParameters([{ type: 'string' }], [JSON.stringify(state.publicPolicy)]);
    throw new Error('unexpected_fixture_read');
  });
  const head = vi.fn(async () => ({ number: state.block, timestamp: BigInt(Math.floor(Date.now() / 1000) - state.headAge) }));
  transport.client = { getChainId: async () => state.chain, getBlock: head, readContract: reads } as unknown as PublicClient;
  return { state, inline, head, reads };
}
function existingAgent(owner: Address): Agent {
  return { id: randomUUID(), ensName: 'existing.owner-fixture.eth', owner, delegate, persona: 'Owner supplied existing persona', config: {}, authority: null,
    policy: { version: 9, purpose: 'collaborator', allowedFields: [], allowedActions: ['discover'], expiresAt: new Date(Date.now() + 3600000).toISOString(), paused: false } };
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-agent-import-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('ENS_SEPOLIA_AUTH_RPC_URL', 'http://explicit-local-fixture.invalid');
  transport.checks.mockReset();
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('owner-reviewed existing ENS identity import', () => {
  it('previews the current public policy without saving any agent or importing private data', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    const response = await call('agent/import/preview', { ensName, delegate }, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toMatchObject({ ensName, owner: owner.wallet.address.toLowerCase(), delegate, policy: decodeInlinePolicyUri(current.state.publicPolicy.uri), policyDigest: current.state.publicPolicy.digest, resolverAddress: resolver, blockNumber: '100' });
    expect(agent(owner.id)).toBeNull();
    expect(transport.checks).toHaveBeenCalledExactlyOnceWith({ ensName, owner: owner.wallet.address.toLowerCase(), delegate, action: 'discover' });
    expect(current.reads.mock.calls.every(([request]) => 'blockNumber' in request)).toBe(true);
    expect(db().prepare('SELECT id FROM audit WHERE user_id=? AND action=?').get(owner.id, 'agent_import')).toBeUndefined();
  });

  it('rechecks authority on confirmation, preserves exact policy version and stores the current receipt only', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    const profileBefore = { ...profile(owner.id), displayName: 'Current local owner', contact: 'current private contact', employer: 'current private employer' };
    db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(profileBefore, `profile:${owner.id}`), owner.id);
    expect((await call('agent/import/preview', { ensName, delegate }, owner.cookie)).status).toBe(200);
    current.state.block = 101n;
    const response = await call('agent/import', { ensName, delegate, reviewedDigest: current.state.publicPolicy.digest }, owner.cookie);
    expect(response.status).toBe(200);
    expect(transport.checks).toHaveBeenCalledTimes(2);
    expect(current.head).toHaveBeenCalledTimes(2);
    const imported = agent(owner.id)!;
    expect(imported).toMatchObject({ ensName, owner: owner.wallet.address.toLowerCase(), delegate, persona: '', policy: decodeInlinePolicyUri(current.state.publicPolicy.uri), config: { resolverAddress: resolver, policyUri: '' },
      authority: { allowed: true, reason: 'current_ensv2_delegation_verified', evidence: { blockNumber: '101', chainId: 11155111, publicPolicy: current.state.publicPolicy, evidence: { registry, resolver, network: 'sepolia' } } } });
    expect(imported.policy.version).toBe(7);
    expect(Date.parse(imported.authority!.checkedAt)).toBeGreaterThan(Date.now() - 5000);
    expect(JSON.stringify(imported)).not.toContain('current private');
    expect(profile(owner.id)).toEqual(profileBefore);
    expect(db().prepare('SELECT outcome FROM audit WHERE user_id=? AND action=?').get(owner.id, 'agent_import')).toEqual({ outcome: 'completed' });
  });

  it('denies confirmation when the reviewed public policy has changed', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    const preview = await call('agent/import/preview', { ensName, delegate }, owner.cookie);
    const reviewedDigest = (await preview.json()).data.policyDigest;
    const changed = { ...current.inline, version: 8 };
    current.state.publicPolicy = { ...current.state.publicPolicy, version: '8', uri: encodeInlinePolicyUri(changed), digest: inlinePolicyDigest(changed) };
    const response = await call('agent/import', { ensName, delegate, reviewedDigest }, owner.cookie);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('POLICY_CHANGED');
    expect(agent(owner.id)).toBeNull();
    expect(transport.checks).toHaveBeenCalledTimes(2);
  });

  it('denies revoked authority between preview and confirmation', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    expect((await call('agent/import/preview', { ensName, delegate }, owner.cookie)).status).toBe(200);
    current.state.granted = false;
    const response = await call('agent/import', { ensName, delegate, reviewedDigest: current.state.publicPolicy.digest }, owner.cookie);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ENS_IMPORT_DENIED');
    expect(agent(owner.id)).toBeNull();
  });

  it.each(['namespace-owner', 'policy-owner', 'policy-delegate', 'policy-name', 'unsupported-chain', 'stale-head', 'paused', 'expired', 'digest-mismatch'])('denies %s authority without saving an agent', async variation => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    if (variation === 'namespace-owner') current.state.owner = outsider;
    if (variation === 'policy-owner') current.state.publicPolicy.owner = outsider;
    if (variation === 'policy-delegate') current.state.publicPolicy.delegate = outsider;
    if (variation === 'policy-name') current.state.publicPolicy.ensName = 'agent.someone-else.eth';
    if (variation === 'unsupported-chain') current.state.chain = 1;
    if (variation === 'stale-head') current.state.headAge = 100;
    if (variation === 'digest-mismatch') current.state.publicPolicy.digest = `0x${'a'.repeat(64)}`;
    if (variation === 'paused' || variation === 'expired') {
      const changed = { ...current.inline, ...(variation === 'paused' ? { paused: true } : { expiresAt: new Date(Date.now() - 1000).toISOString() }) };
      current.state.publicPolicy = { ...current.state.publicPolicy, uri: encodeInlinePolicyUri(changed), digest: inlinePolicyDigest(changed), expiresAt: Math.floor(Date.parse(changed.expiresAt) / 1000) };
    }
    const response = await call('agent/import', { ensName, delegate, reviewedDigest: current.state.publicPolicy.digest }, owner.cookie);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ENS_IMPORT_DENIED');
    expect(agent(owner.id)).toBeNull();
  });

  it('preserves an existing saved agent instead of replacing it through import', async () => {
    const owner = await signIn();
    fixture(owner.wallet.address);
    const saved = existingAgent(owner.wallet.address);
    saveAgent(owner.id, saved);
    for (const endpoint of ['agent/import/preview', 'agent/import']) {
      const response = await call(endpoint, { ensName, delegate, ...(endpoint === 'agent/import' ? { reviewedDigest: `0x${'a'.repeat(64)}` } : {}) }, owner.cookie);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('AGENT_EXISTS');
    }
    expect(transport.checks).not.toHaveBeenCalled();
    expect(agent(owner.id)).toEqual(saved);
  });

  it('refuses to overwrite an agent created while the authority check was in progress', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    const saved = existingAgent(owner.wallet.address);
    current.head.mockImplementationOnce(async () => {
      saveAgent(owner.id, saved);
      return { number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    });
    const response = await call('agent/import', { ensName, delegate, reviewedDigest: current.state.publicPolicy.digest }, owner.cookie);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('AGENT_EXISTS');
    expect(agent(owner.id)).toEqual(saved);
  });

  it.each(['agent/import/preview', 'agent/import'])('denies %s after logout during a genuine verifier check', async endpoint => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    current.head.mockImplementationOnce(async () => {
      entered();
      await paused;
      return { number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    });
    const pending = call(endpoint, { ensName, delegate, ...(endpoint === 'agent/import' ? { reviewedDigest: current.state.publicPolicy.digest } : {}) }, owner.cookie);
    await started;
    expect((await call('auth/logout', {}, owner.cookie)).status).toBe(200);
    resume();
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED');
    expect(transport.checks).toHaveBeenCalledTimes(1);
    expect(current.reads).toHaveBeenCalled();
    expect(agent(owner.id)).toBeNull();
    expect(db().prepare('SELECT id FROM audit WHERE user_id=? AND action=?').get(owner.id, 'agent_import')).toBeUndefined();
  });

  it('requires the authenticated owner wallet, same origin, and strict reviewed inputs', async () => {
    expect((await call('agent/import/preview', { ensName, delegate })).status).toBe(401);
    const email = await call('auth/register', { email: 'wallet-required@example.test', password: 'a sufficiently long password' });
    const emailCookie = email.headers.getSetCookie()[0].split(';')[0];
    expect((await call('agent/import/preview', { ensName, delegate }, emailCookie)).status).toBe(409);
    const owner = await signIn();
    fixture(owner.wallet.address);
    expect((await call('agent/import/preview', { ensName, delegate }, owner.cookie, 'https://elsewhere.example')).status).toBe(403);
    expect((await call('agent/import/preview', { ensName, delegate, owner: outsider }, owner.cookie)).status).toBe(400);
    expect((await call('agent/import', { ensName, delegate }, owner.cookie)).status).toBe(400);
    expect(transport.checks).not.toHaveBeenCalled();
    expect(agent(owner.id)).toBeNull();
  });

  it('rejects external policy URIs when the verifier has no independently expected policy digest', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    current.state.publicPolicy.uri = 'https://example.invalid/public-policy/7';
    const response = await call('agent/import', { ensName, delegate, reviewedDigest: current.state.publicPolicy.digest }, owner.cookie);
    expect(response.status).toBe(403);
    const error = (await response.json()).error;
    expect(error.code).toBe('ENS_IMPORT_DENIED');
    expect(error.message).toContain('expected_policy_digest_required');
    expect(agent(owner.id)).toBeNull();
  });

  it('denies unconfigured ENS and provider failure without exposing arbitrary upstream text', async () => {
    const owner = await signIn(), current = fixture(owner.wallet.address);
    vi.stubEnv('ENS_SEPOLIA_AUTH_RPC_URL', '');
    vi.stubEnv('ENS_SEPOLIA_RPC_URL', '');
    expect((await call('agent/import/preview', { ensName, delegate }, owner.cookie)).status).toBe(503);
    vi.stubEnv('ENS_SEPOLIA_AUTH_RPC_URL', 'http://explicit-local-fixture.invalid');
    current.reads.mockRejectedValue(new Error('upstream private fixture secret'));
    const response = await call('agent/import/preview', { ensName, delegate }, owner.cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('upstream private fixture secret');
    expect(agent(owner.id)).toBeNull();
  });
});
