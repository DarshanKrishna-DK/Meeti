import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), confirm: vi.fn(), records: vi.fn(), deployment: vi.fn(), association: vi.fn(), parent: vi.fn(), receipt: vi.fn() }));
// Sponsor RPC and contract decisions are fixtures. SQLite, session, tenancy and operation journaling are real.
vi.mock('../packages/ens', async original => ({ ...await original<typeof import('../packages/ens')>(), createEnsAuthorityProvider: () => ({ readPublicAgentRecords: mocks.records, inspectProjectParent: mocks.parent, disconnect: vi.fn() }) }));
vi.mock('../packages/ens/agent-identity', async original => ({ ...await original<typeof import('../packages/ens/agent-identity')>(), createAgentIdentityProvider: () => ({ prepareTransaction: mocks.prepare, confirmTransaction: mocks.confirm, inspectDeployment: mocks.deployment, verifyAssociation: mocks.association, disconnect: vi.fn() }) }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({ estimateGas: async () => 100000n, getGasPrice: async () => 1000000000n, getTransactionReceipt: mocks.receipt }) }));
import { agent, closeDatabase, db, saveAgent, type UserRow } from '../packages/server/db';
import { encrypt, decrypt } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';
import { approvedAgentOrigin, handleIdentity, publicAgentResponse } from '../packages/server/identity';
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
});
