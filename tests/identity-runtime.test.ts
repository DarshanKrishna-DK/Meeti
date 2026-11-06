import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), publicPrepare: vi.fn(), confirm: vi.fn(), records: vi.fn(), deployment: vi.fn(), association: vi.fn(), parent: vi.fn(), receipt: vi.fn() }));
// Sponsor RPC and contract decisions are fixtures. SQLite, session, tenancy and operation journaling are real.
vi.mock('../packages/ens', async original => ({ ...await original<typeof import('../packages/ens')>(), createEnsAuthorityProvider: () => ({ readPublicAgentRecords: mocks.records, preparePublicAgentRecord: mocks.publicPrepare, inspectProjectParent: mocks.parent, disconnect: vi.fn() }) }));
vi.mock('../packages/ens/agent-identity', async original => ({ ...await original<typeof import('../packages/ens/agent-identity')>(), createAgentIdentityProvider: () => ({ prepareTransaction: mocks.prepare, confirmTransaction: mocks.confirm, inspectDeployment: mocks.deployment, verifyAssociation: mocks.association, disconnect: vi.fn() }) }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({ estimateGas: async () => 100000n, getGasPrice: async () => 1000000000n, getTransactionReceipt: mocks.receipt }) }));
import { agent, closeDatabase, db, saveAgent, type UserRow } from '../packages/server/db';
import { encrypt, decrypt } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';
import { approvedAgentOrigin, handleIdentity, publicAgentResponse, resolveCurrentPublicAgentIdentity, resolveCurrentPublicAgentIdentityForUser } from '../packages/server/identity';
import { agentRegistrationKey } from '../packages/ens/agent-records';
const owner = '0x1111111111111111111111111111111111111111', origin = 'http://127.0.0.1:3198';
let directory: string, actor: UserRow, cookie: string;
function request() { return new Request(origin + '/api/identity', { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie } }); }
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-identity-runtime-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('PUBLIC_APP_ORIGIN', ''); vi.stubEnv('ENS_SEPOLIA_RPC_URL', 'https://rpc.fixture.invalid');
  actor = { id: randomUUID(), email: randomUUID() + '@fixture.invalid', password_hash: '', wallet: owner, profile: encrypt({}, 'unused'), created_at: new Date().toISOString() };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(actor.id, actor.email, '', owner, actor.profile, actor.created_at);
  cookie = createSession(actor.id).split(';')[0];
  saveAgent(actor.id, { id: randomUUID(), ensName: 'agent.fixture.eth', owner, delegate: '0x2222222222222222222222222222222222222222', persona: '', config: {}, authority: null,
    policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['discover'], expiresAt: new Date(Date.now() + 3600000).toISOString(), paused: false } });
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.prepare.mockResolvedValue({ chainId: 11155111, from: owner, to: owner, data: '0x1234', value: '0x0', operation: 'register-identity', ensName: 'agent.fixture.eth', blockNumber: '123', warning: 'Fixture' });
  mocks.publicPrepare.mockImplementation(async value => ({ chainId: 11155111, from: owner, to: owner, data: '0x5678', value: '0x0', operation: 'set-public-agent-record', ensName: value.ensName, key: value.key, publicValue: value.value }));
  mocks.deployment.mockResolvedValue({ verified: true, associationVerified: false });
  mocks.receipt.mockResolvedValue({ gasUsed: 100000n, effectiveGasPrice: 1000000000n });
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
async function prepare() {
  const response = await handleIdentity(request(), 'identity/prepare', actor, { operation: 'register-identity', maxFeeWei: '500000000000000' });
  return (await response!.json()).data as { operationId: string; transaction: unknown };
}
describe('identity runtime boundaries with contract fixtures', () => {
  it('journals an unsigned exact transaction with owner binding and bounded quote', async () => {
    const value = await prepare();
    const row = db().prepare('SELECT * FROM operations WHERE id=?').get(value.operationId) as { data: string; state: string };
    expect(row.state).toBe('prepared');
    expect(decrypt(row.data, `operation:${value.operationId}`)).toMatchObject({ maxFeeWei: '500000000000000', transaction: { from: owner, data: '0x1234', gas: '0x1d4c0', gasPrice: '0x47868c00' } });
  });
  it('rejects another pending operation rather than preparing duplicate registrations', async () => { await prepare(); await expect(prepare()).rejects.toMatchObject({ code: 'TRANSACTION_UNRESOLVED' }); });
  it('does not prepare above the explicit network cap', async () => {
    await expect(handleIdentity(request(), 'identity/prepare', actor, { operation: 'register-identity', maxFeeWei: '6000000000000000' })).rejects.toThrow();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('does not treat a submitted hash as confirmation', async () => {
    const value = await prepare();
    const response = await handleIdentity(request(), 'identity/submitted', actor, { operationId: value.operationId, hash: '0x' + 'ab'.repeat(32) });
    expect((await response!.json()).data).toEqual({ submitted: true, confirmed: false });
    expect(db().prepare('SELECT * FROM agent_registrations').all()).toHaveLength(0);
  });
  it('protects prepared transactions from a second account', async () => {
    const value = await prepare();
    const other = { ...actor, id: randomUUID(), email: randomUUID() + '@fixture.invalid', wallet: '0x3333333333333333333333333333333333333333' };
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(other.id, other.email, '', other.wallet, other.profile, other.created_at);
    saveAgent(other.id, { ...agent(actor.id)!, id: randomUUID(), ensName: 'agent.other-fixture.eth', owner: other.wallet });
    await expect(handleIdentity(request(), 'identity/confirm', other, { operationId: value.operationId, hash: '0x' + 'ab'.repeat(32) })).rejects.toMatchObject({ status: 404 });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('rejects client calldata or unsupported request fields', async () => {
    await expect(handleIdentity(request(), 'identity/prepare', actor, { operation: 'register-identity', maxFeeWei: '500000000000000', data: '0xdead' })).rejects.toThrow();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('does not persist a registration when session is revoked during confirmation', async () => {
    const value = await prepare();
    mocks.confirm.mockImplementation(async () => { db().prepare('DELETE FROM sessions').run(); return { confirmed: true, identity: { chainId: 11155111, registry: owner, agentId: '7' }, blockNumber: '125' }; });
    await expect(handleIdentity(request(), 'identity/confirm', actor, { operationId: value.operationId, hash: '0x' + 'ab'.repeat(32) })).rejects.toMatchObject({ status: 401 });
    expect(db().prepare('SELECT * FROM agent_registrations').all()).toHaveLength(0);
  });
  it('stores the actual confirmed registry tuple without claiming association', async () => {
    const value = await prepare();
    mocks.confirm.mockResolvedValue({ confirmed: true, identity: { chainId: 11155111, registry: owner, agentId: '7' }, blockNumber: '125', associationVerified: false });
    const response = await handleIdentity(request(), 'identity/confirm', actor, { operationId: value.operationId, hash: '0x' + 'ab'.repeat(32) });
    expect((await response!.json()).data.associationVerified).toBe(false);
    const row = db().prepare('SELECT data FROM agent_registrations WHERE user_id=?').get(actor.id) as { data: string };
    expect(decrypt(row.data, `agent-registration:${actor.id}`)).toMatchObject({ identity: { chainId: 11155111, registry: owner, agentId: '7' } });
  });
  it.each(['http://localhost:3173', 'https://127.0.0.1', 'https://172.16.1.2', 'https://192.168.0.1'])('rejects local origins for public endpoints: %s', value => { vi.stubEnv('PUBLIC_APP_ORIGIN', value); expect(approvedAgentOrigin).toThrow(); });
  it('does not serve an unpublished profile as a public card', async () => { await expect(publicAgentResponse('agent.fixture.eth', 'context')).rejects.toMatchObject({ status: 404 }); expect(mocks.records).not.toHaveBeenCalled(); });
  it('prepares approved onchain context without a deployment and publishes no fabricated endpoint', async () => {
    const response = await handleIdentity(request(), 'identity/prepare', actor, { operation: 'publish-context', name: 'Fixture agent', description: 'Approved public description.', publicApproved: true, maxFeeWei: '500000000000000' });
    expect(response!.status).toBe(200);
    expect(mocks.publicPrepare).toHaveBeenCalledWith(expect.objectContaining({ key: 'agent-context' }));
    expect(JSON.parse(mocks.publicPrepare.mock.calls[0][0].value)).toMatchObject({ name: 'Fixture agent', endpoints: [] });
  });
  it('continues to reject local endpoint publication even when context can be prepared', async () => {
    await expect(handleIdentity(request(), 'identity/prepare', actor, { operation: 'publish-endpoint', name: 'Fixture agent', description: 'Approved.', publicApproved: true, maxFeeWei: '500000000000000' })).rejects.toMatchObject({ code: 'PUBLIC_ENDPOINT_UNAVAILABLE' });
    expect(mocks.publicPrepare).not.toHaveBeenCalled();
  });
  it('requires explicit approval for context and does not journal unapproved text', async () => {
    await expect(handleIdentity(request(), 'identity/prepare', actor, { operation: 'publish-context', name: 'Fixture agent', description: 'Unapproved.', maxFeeWei: '500000000000000' })).rejects.toMatchObject({ code: 'PUBLIC_APPROVAL_REQUIRED' });
    expect(mocks.publicPrepare).not.toHaveBeenCalled(); expect(db().prepare('SELECT * FROM operations').all()).toHaveLength(0);
  });
});

const publicContext = () => ({ type: 'meeti-agent-context-v1', ensName: 'agent.fixture.eth', name: 'Public fixture', description: 'Approved public test description.', capabilities: ['discover'], endpoints: [] });
const identity = { chainId: 11155111, registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const, agentId: '7' };
function recordSnapshot(context?: object, extra: Record<string, string> = {}) {
  return { chainId: 11155111, ensName: 'agent.fixture.eth', owner, registry: owner, resolver: owner, blockNumber: '123', checkedAt: new Date().toISOString(), records: { 'agent-context': context ? JSON.stringify(context) : '', ...extra } };
}
function storePublic(value: object) {
  db().prepare('INSERT INTO agent_registrations VALUES(?,?,?)').run(actor.id, encrypt({ ensName: 'agent.fixture.eth', receipts: [], ...value }, `agent-registration:${actor.id}`), new Date().toISOString());
}
describe('current public identity resolution with contract fixtures', () => {
  it('prepares ENS-only registration metadata without requiring public hosting', async () => {
    storePublic({ context: publicContext(), identity });
    const response = await handleIdentity(request(), 'identity/prepare', actor, { operation: 'set-identity-uri', maxFeeWei: '500000000000000' });
    expect(response!.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ operation: 'set-identity-uri', document: expect.objectContaining({ services: [{ name: 'ENS', endpoint: 'agent.fixture.eth', version: 'v2' }] }) }));
  });
  it('publishes an optional real endpoint without silently changing the already approved context JSON', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://example.org');
    storePublic({ context: publicContext() }); mocks.records.mockResolvedValue(recordSnapshot(publicContext()));
    const response = await handleIdentity(request(), 'identity/prepare', actor, { operation: 'publish-endpoint', publicApproved: true, maxFeeWei: '500000000000000' });
    const prepared = (await response!.json()).data;
    expect(mocks.publicPrepare).toHaveBeenCalledWith(expect.objectContaining({ key: 'agent-endpoint[meeti-rest-v1]', value: 'https://example.org/api/public/agents/agent.fixture.eth/context' }));
    expect(prepared.context).toEqual(publicContext());
  });
  it('distinguishes unpublished optional identity from verified identity without granting authority', async () => {
    mocks.records.mockResolvedValue(recordSnapshot());
    expect(await resolveCurrentPublicAgentIdentityForUser(actor.id)).toMatchObject({ context: { state: 'absent' }, association: { state: 'absent' }, authorityVerified: false, humanVerified: false });
    expect(mocks.association).not.toHaveBeenCalled();
  });
  it('resolves valid endpoint-free JSON context through actual reader interface calls', async () => {
    mocks.records.mockResolvedValue(recordSnapshot(publicContext()));
    expect(await resolveCurrentPublicAgentIdentityForUser(actor.id)).toMatchObject({ context: { state: 'valid', value: { endpoints: [] } }, association: { state: 'absent' }, observed: { blockNumber: '123' } });
    expect(mocks.records).toHaveBeenCalledWith(expect.objectContaining({ ensName: 'agent.fixture.eth', owner, keys: expect.arrayContaining(['agent-context']) }));
  });
  it('serves an approved resolved context without requiring any endpoint record', async () => {
    storePublic({ context: publicContext() }); mocks.records.mockResolvedValue(recordSnapshot(publicContext()));
    const response = await publicAgentResponse('agent.fixture.eth', 'context');
    expect(await response.json()).toMatchObject({ name: 'Public fixture', endpoints: [], registrationAssociationState: 'absent' });
  });
  it('keeps a published context mandatory after removal and rejects malformed or substituted context', async () => {
    storePublic({ context: publicContext() }); mocks.records.mockResolvedValue(recordSnapshot());
    expect(await resolveCurrentPublicAgentIdentityForUser(actor.id)).toMatchObject({ context: { state: 'invalid', reason: 'previously_confirmed_context_missing' } });
    mocks.records.mockResolvedValue({ ...recordSnapshot(), records: { 'agent-context': '# Unsupported remote Markdown instructions' } });
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).context.state).toBe('invalid');
    mocks.records.mockResolvedValue(recordSnapshot({ ...publicContext(), ensName: 'agent.other.eth' }));
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).context).toMatchObject({ state: 'invalid', reason: 'agent_context_name_mismatch' });
  });
  it('requires declared endpoint values to match current ENS and preserves HTTPS validation', async () => {
    const endpoint = { protocol: 'meeti-rest-v1', url: 'https://example.org/real-context' };
    mocks.records.mockResolvedValue(recordSnapshot({ ...publicContext(), endpoints: [endpoint] }));
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).context).toMatchObject({ state: 'invalid', reason: 'declared_endpoint_record_mismatch' });
    mocks.records.mockResolvedValue(recordSnapshot({ ...publicContext(), endpoints: [endpoint] }, { 'agent-endpoint[meeti-rest-v1]': endpoint.url }));
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).context.state).toBe('valid');
    mocks.records.mockResolvedValue(recordSnapshot({ ...publicContext(), endpoints: [{ ...endpoint, url: 'http://localhost' }] }));
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).context.state).toBe('invalid');
  });
  it('verifies exact stored or declared registry identity and rejects stale or conflicting association', async () => {
    mocks.records.mockResolvedValue(recordSnapshot({ ...publicContext(), registration: identity }, { [agentRegistrationKey(identity)]: '1' }));
    mocks.association.mockResolvedValue({ verified: true, identity, authorityVerified: false });
    expect((await resolveCurrentPublicAgentIdentity({ ensName: 'agent.fixture.eth', owner })).association.state).toBe('verified');
    expect(mocks.association).toHaveBeenCalledWith({ ensName: 'agent.fixture.eth', owner, identity });
    mocks.association.mockResolvedValue({ verified: false, reason: 'ens_registration_attestation_missing', authorityVerified: false });
    expect((await resolveCurrentPublicAgentIdentity({ ensName: 'agent.fixture.eth', owner, identity })).association).toMatchObject({ state: 'invalid', reason: 'ens_registration_attestation_missing' });
    mocks.association.mockClear();
    expect((await resolveCurrentPublicAgentIdentity({ ensName: 'agent.fixture.eth', owner, identity: { ...identity, agentId: '8' } })).association).toMatchObject({ state: 'invalid', reason: 'registration_tuple_mismatch' });
    expect(mocks.association).not.toHaveBeenCalled();
  });
  it('requires a stored identity to verify even if context is absent and propagates RPC failure', async () => {
    storePublic({ identity }); mocks.records.mockResolvedValue(recordSnapshot()); mocks.association.mockResolvedValue({ verified: false, reason: 'identity_registration_uri_missing' });
    expect((await resolveCurrentPublicAgentIdentityForUser(actor.id)).association.state).toBe('invalid');
    mocks.records.mockRejectedValue(new Error('fixture_rpc_unavailable'));
    await expect(resolveCurrentPublicAgentIdentityForUser(actor.id)).rejects.toThrow('fixture_rpc_unavailable');
  });
  it('does not serve registry metadata when current association is invalid', async () => {
    storePublic({ context: publicContext(), identity }); mocks.records.mockResolvedValue(recordSnapshot(publicContext()));
    mocks.association.mockResolvedValue({ verified: false, reason: 'ens_registration_attestation_missing' });
    await expect(publicAgentResponse('agent.fixture.eth', 'registration')).rejects.toMatchObject({ code: 'ASSOCIATION_UNVERIFIED' });
  });
});
