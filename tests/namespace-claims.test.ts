import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), recipientRegistry: vi.fn(), subname: vi.fn(), transaction: vi.fn(), confirm: vi.fn(), state: vi.fn(), receipt: vi.fn() }));
// Contract responses are fixtures. The database, authenticated sessions and tenant-scoped journals are real.
vi.mock('../packages/ens', async original => ({ ...await original<typeof import('../packages/ens')>(), createEnsAuthorityProvider: () => ({ inspectProjectParent: mocks.inspect, prepareProjectRecipientRegistry: mocks.recipientRegistry, prepareProjectSubname: mocks.subname, prepareTransaction: mocks.transaction, confirmTransaction: mocks.confirm, disconnect: vi.fn() }) }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({ estimateGas: async () => 100000n, getGasPrice: async () => 1000000000n, readContract: mocks.state, getTransactionReceipt: mocks.receipt }) }));
import { closeDatabase, db, type UserRow } from '../packages/server/db';
import { decrypt, encrypt } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';
import { handleNamespaceClaims } from '../packages/server/namespace-claims';
const issuer = '0x1111111111111111111111111111111111111111', recipient = '0x2222222222222222222222222222222222222222', registry = '0x3333333333333333333333333333333333333333';
const origin = 'http://127.0.0.1:3198', hash = '0x' + 'ab'.repeat(32);
let directory: string, operator: UserRow, owner: UserRow, branchReady: boolean, recipientReady: boolean;
const cookies = new Map<string, string>();
async function fixture(wallet: string): Promise<UserRow> { const row = { id: randomUUID(), email: randomUUID() + '@fixture.invalid', wallet, password_hash: '', profile: encrypt({}, 'unused'), created_at: new Date().toISOString() }; db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(row.id, row.email, '', wallet, row.profile, row.created_at); cookies.set(row.id, (await createSession(row.id)).split(';')[0]); return row; }
function request(actor: UserRow, method = 'POST') { return new Request(origin + '/api/namespace', { method, headers: { cookie: cookies.get(actor.id)!, origin, 'content-type': 'application/json' } }); }
async function call(actor: UserRow, key: string, body?: unknown) { const response = await handleNamespaceClaims(request(actor, body === undefined ? 'GET' : 'POST'), key, actor, body); return (await response!.json()).data; }
async function claim(label = 'alice') { return (await call(owner, 'namespace/claim', { label, publicNameAndWalletApproved: true })).claim; }
function unsigned(operation: string, ensName: string, data = '0x1234') { return { chainId: 11155111, from: issuer, to: registry, data, value: '0x0', operation, ensName }; }
beforeEach(async () => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-namespace-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('ENS_PROJECT_PARENT', 'meeti-demo.eth'); vi.stubEnv('ENS_PROJECT_ISSUER', issuer); vi.stubEnv('ENS_SEPOLIA_RPC_URL', 'https://rpc.fixture.invalid');
  cookies.clear(); operator = await fixture(issuer); owner = await fixture(recipient); branchReady = false; recipientReady = false;
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.inspect.mockImplementation(async ({ parentName, issuer: currentOwner }) => {
    if (parentName === 'users.meeti-demo.eth' && !branchReady) throw new Error('namespace_unregistered_or_expired');
    return { chainId: 11155111, parentName, issuer: currentOwner, parentRegistry: registry, subregistry: registry, predictedRegistry: registry, issuerRootRoles: '1', nextStep: 'ready', expiresAt: new Date(Date.now() + 86400000).toISOString(), blockNumber: '123', parentControl: 'Project ancestor retains control.' };
  });
  mocks.state.mockResolvedValue({ status: 0, expiry: 0n });
  mocks.recipientRegistry.mockImplementation(async ({ label }) => recipientReady ? { needed: false, predictedAddress: registry } : { ...unsigned('deploy-recipient-registry', `${label}.users.meeti-demo.eth`), needed: true, predictedAddress: registry });
  mocks.subname.mockImplementation(async ({ label, parentName }) => unsigned('issue-project-subname', `${label}.${parentName}`));
  mocks.transaction.mockImplementation(async ({ operation, ensName }) => unsigned(operation, ensName));
  mocks.confirm.mockResolvedValue({ confirmed: true, chainId: 11155111, blockNumber: '125', transactionHash: hash });
  mocks.receipt.mockResolvedValue({ gasUsed: 100000n, effectiveGasPrice: 1000000000n });
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe('namespace claims and unsigned issuer execution with chain fixtures', () => {
  it('creates a stable wallet-owned request without needing an agent or pretending branch exists', async () => {
    const first = await claim(' Alice '), second = await claim('alice');
    expect(first).toMatchObject({ label: 'alice', state: 'requested', recipient, userName: 'alice.users.meeti-demo.eth', agentName: 'networking.alice.users.meeti-demo.eth', agentConfirmed: false });
    expect(second.id).toBe(first.id); expect(db().prepare('SELECT * FROM namespace_claims').all()).toHaveLength(1);
  });
  it('requires explicit approval for public name and wallet linkage', async () => { await expect(call(owner, 'namespace/claim', { label: 'alice' })).rejects.toThrow(); expect(db().prepare('SELECT * FROM namespace_claims').all()).toHaveLength(0); });
  it('rejects reserved names before querying chain', async () => { await expect(claim('admin')).rejects.toMatchObject({ code: 'NAME_RESERVED' }); expect(mocks.inspect).not.toHaveBeenCalled(); });
  it('does not reserve an onchain-used label', async () => { branchReady = true; mocks.state.mockResolvedValue({ status: 2, expiry: 123n }); await expect(claim()).rejects.toMatchObject({ code: 'NAME_UNAVAILABLE' }); });
  it('denies a second wallet the same locally reserved label', async () => { await claim(); const other = await fixture('0x4444444444444444444444444444444444444444'); await expect(call(other, 'namespace/claim', { label: 'alice', publicNameAndWalletApproved: true })).rejects.toMatchObject({ code: 'NAME_REQUESTED' }); });
  it('serializes concurrent claims from two distinct wallet accounts', async () => {
    const other = await fixture('0x4444444444444444444444444444444444444444');
    const results = await Promise.allSettled([call(owner, 'namespace/claim', { label: 'alice', publicNameAndWalletApproved: true }), call(other, 'namespace/claim', { label: 'alice', publicNameAndWalletApproved: true })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(db().prepare('SELECT id FROM namespace_claims').all()).toHaveLength(1);
  });
  it('lists other recipient requests only for the authenticated issuer', async () => { await claim(); const other = await fixture('0x4444444444444444444444444444444444444444'); expect((await call(other, 'namespace/claims')).requests).toEqual([]); expect((await call(operator, 'namespace/claims')).requests).toHaveLength(1); });
  it('prepares only the real missing branch step and makes no signature request', async () => {
    const result = await call(operator, 'namespace/prepare-branch', { maxFeeWei: '500000000000000' });
    expect(result.transaction).toMatchObject({ operation: 'issue-project-subname', ensName: 'users.meeti-demo.eth', from: issuer });
    expect(mocks.subname).toHaveBeenCalledWith(expect.objectContaining({ parentName: 'meeti-demo.eth', label: 'users', recipient: issuer }));
    expect((db().prepare('SELECT state FROM operations WHERE id=?').get(result.operationId) as { state: string }).state).toBe('prepared');
  });
  it('denies issuer preparation from an ordinary recipient account', async () => { await expect(call(owner, 'namespace/prepare-branch', { maxFeeWei: '500000000000000' })).rejects.toMatchObject({ code: 'ISSUER_REQUIRED' }); expect(mocks.subname).not.toHaveBeenCalled(); });
  it('keeps recipient registry control with the recipient and requires branch readiness', async () => {
    const row = await claim();
    await expect(call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' })).rejects.toMatchObject({ code: 'NAMESPACE_SETUP_REQUIRED' });
    branchReady = true;
    const result = await call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' });
    expect(result.transaction.operation).toBe('deploy-recipient-registry');
    expect(mocks.recipientRegistry).toHaveBeenCalledWith({ parentName: 'users.meeti-demo.eth', label: 'alice', issuer, recipient });
    expect((await call(owner, 'namespace/claims')).claim.agentConfirmed).toBe(false);
  });
  it('marks submitted hashes as pending and does not mark user issuance confirmed', async () => {
    branchReady = true; const row = await claim();
    const prepared = await call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' });
    expect(await call(operator, 'namespace/submitted', { operationId: prepared.operationId, hash })).toMatchObject({ submitted: true, confirmed: false });
    expect((await call(owner, 'namespace/claims')).claim.state).toBe('prepared');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('does not confirm a registry until actual read-back sees deployed recipient control', async () => {
    branchReady = true; const row = await claim();
    const prepared = await call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' });
    await expect(call(operator, 'namespace/confirm', { operationId: prepared.operationId, hash })).rejects.toMatchObject({ code: 'REGISTRY_READBACK_FAILED' });
    recipientReady = true;
    expect(await call(operator, 'namespace/confirm', { operationId: prepared.operationId, hash })).toMatchObject({ confirmed: true });
    const updated = (await call(owner, 'namespace/claims')).claim;
    expect(updated.state).toBe('requested'); expect(updated.recipientRegistry).toBe(registry); expect(updated.agentConfirmed).toBe(false);
  });
  it('issues the name to the requested recipient with its verified registry and confirms separately from agent creation', async () => {
    branchReady = true; recipientReady = true; const row = await claim();
    const prepared = await call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' });
    expect(mocks.subname).toHaveBeenCalledWith(expect.objectContaining({ recipient, recipientSubregistry: registry }));
    await call(operator, 'namespace/confirm', { operationId: prepared.operationId, hash });
    expect((await call(owner, 'namespace/claims')).claim).toMatchObject({ state: 'confirmed', userRegistry: registry, agentConfirmed: false, resolver: null });
  });
  it('rejects expired unsigned submission reviews', async () => {
    const prepared = await call(operator, 'namespace/prepare-branch', { maxFeeWei: '500000000000000' });
    const row = db().prepare('SELECT data FROM operations WHERE id=?').get(prepared.operationId) as { data: string };
    const data = decrypt<Record<string, unknown>>(row.data, `operation:${prepared.operationId}`);
    db().prepare('UPDATE operations SET data=? WHERE id=?').run(encrypt({ ...data, expiresAt: new Date(0).toISOString() }, `operation:${prepared.operationId}`), prepared.operationId);
    await expect(call(operator, 'namespace/submitted', { operationId: prepared.operationId, hash })).rejects.toMatchObject({ code: 'PREPARATION_EXPIRED' });
  });
  it('invalidates stale recipient request versions and prevents withdrawal while issuance is unresolved', async () => {
    const row = await claim(); branchReady = true;
    await call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' });
    await expect(call(owner, 'namespace/withdraw', { version: row.version })).rejects.toMatchObject({ code: 'CLAIM_IN_PROGRESS' });
    await expect(call(operator, 'namespace/prepare-claim', { claimId: row.id, version: row.version, maxFeeWei: '500000000000000' })).rejects.toMatchObject({ code: 'CLAIM_CHANGED' });
  });
});
