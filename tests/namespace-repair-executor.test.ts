import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const forbidden = vi.hoisted(() => ({
  rpc: vi.fn(() => { throw new Error('Fixture forbids RPC construction.'); }),
  wallet: vi.fn(() => { throw new Error('Fixture forbids wallet access.'); }),
  decrypt: vi.fn(() => { throw new Error('Fixture forbids private vault access.'); }),
  encrypt: vi.fn(() => { throw new Error('Fixture forbids journal writes.'); }),
}));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: forbidden.rpc }));
vi.mock('viem/accounts', async original => ({ ...await original<typeof import('viem/accounts')>(), privateKeyToAccount: forbidden.wallet }));
vi.mock('../packages/server/crypto', async original => ({ ...await original<typeof import('../packages/server/crypto')>(), decrypt: forbidden.decrypt, encrypt: forbidden.encrypt }));
import { sign } from '../packages/server/crypto';

let verify: typeof import('../scripts/execute-namespace-repair')['repairReviewFreshness'];
let importExitCode: typeof process.exitCode;
const now = Date.parse('2026-11-06T18:30:00.000Z');
const address = `0x${'22'.repeat(20)}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const totalCaps = { [address]: '100' };
  const review = { chainId: 11155111, totalCaps, reviewExpiresAt: new Date(now + 60_000).toISOString() };
  const reviewRaw = JSON.stringify(review);
  const approval = { authorized: true, reviewSha256: sha(reviewRaw), chainId: 11155111, totalCaps,
    approvedAt: new Date(now - 1000).toISOString(), allowReadOnlyFreshnessRenewal: true };
  const approvalRaw = JSON.stringify(approval), journalRaw = 'fixture-opaque-encrypted-journal';
  const payload = { version: 1, kind: 'meeti-namespace-repair-freshness-v1', reviewSha256: sha(reviewRaw),
    approvalSha256: sha(approvalRaw), journalSha256: sha(journalRaw), chainId: 11155111,
    checkedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
    blockNumber: '1', blockHash: `0x${'33'.repeat(32)}`, totalCaps, scopeChanged: false, signaturesRequested: 0, transactionsSubmitted: 0 };
  return { review, reviewRaw, approval, approvalRaw, journalRaw, payload };
}
const renewal = (payload: ReturnType<typeof fixture>['payload']) => JSON.stringify({ payload, mac: sign(JSON.stringify(payload)) });

// All records and the encryption key below are synthetic. No wallet or live chain evidence is claimed.
beforeAll(async () => {
  const before = process.exitCode;
  verify = (await import('../scripts/execute-namespace-repair')).repairReviewFreshness;
  importExitCode = process.exitCode;
  expect(importExitCode).toBe(before);
});
beforeEach(() => { vi.stubEnv('DATA_ENCRYPTION_KEY', '11'.repeat(32)); });
afterEach(() => {
  for (const mock of Object.values(forbidden)) expect(mock).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

describe('namespace repair freshness and import guards with synthetic fixtures', () => {
  it('imports the executor without running its entry point, accessing keys or constructing RPC', () => {
    expect(verify).toBeTypeOf('function');
    expect(process.exitCode).toBe(importExitCode);
  });

  it('retains the exact original deadline without automatically renewing an expired review', () => {
    const value = fixture();
    expect(verify({ ...value, now })).toEqual({ deadline: now + 60_000, source: 'original-review' });
    expect(verify({ ...value, now: now + 120_000 }).deadline).toBeLessThan(now + 120_000);
  });

  it('accepts only an authenticated bounded renewal of the identical approval, caps and journal', () => {
    const value = fixture();
    expect(verify({ ...value, renewalRaw: renewal(value.payload), now })).toEqual({
      deadline: now + 60_000, source: 'verified-renewal', blockNumber: '1', blockHash: value.payload.blockHash,
    });
  });

  it.each([
    ['authorization', { authorized: false }], ['review hash', { reviewSha256: '00'.repeat(32) }],
    ['chain', { chainId: 1 }], ['caps', { totalCaps: { [address]: '101' } }],
  ])('rejects changed approval %s', (_name, patch) => {
    const value = fixture();
    expect(() => verify({ ...value, approvalRaw: JSON.stringify({ ...value.approval, ...patch }), now })).toThrow();
  });

  it('rejects changed review bytes even when the parsed scope appears identical', () => {
    const value = fixture();
    expect(() => verify({ ...value, reviewRaw: `${value.reviewRaw}\n`, now })).toThrow('scope_mismatch');
  });

  it.each([
    ['scope', { scopeChanged: true }], ['chain', { chainId: 1 }], ['version', { version: 2 }],
    ['kind', { kind: 'another-purpose' }], ['signature count', { signaturesRequested: 1 }],
    ['transaction count', { transactionsSubmitted: 1 }], ['review hash', { reviewSha256: 'changed' }],
    ['approval hash', { approvalSha256: 'changed' }], ['journal hash', { journalSha256: 'changed' }],
    ['caps', { totalCaps: { [address]: '101' } }], ['block number', { blockNumber: '-1' }],
    ['block hash', { blockHash: '0x00' }],
  ])('rejects an authentic MAC whose renewal changes %s', (_name, patch) => {
    const value = fixture(), payload = { ...value.payload, ...patch };
    expect(() => verify({ ...value, renewalRaw: renewal(payload), now })).toThrow();
  });

  it.each([
    ['long lifetime', { validUntil: new Date(now + 21 * 60_000).toISOString() }],
    ['expired', { validUntil: new Date(now).toISOString() }],
    ['future check', { checkedAt: new Date(now + 1).toISOString() }],
    ['predates approval', { checkedAt: new Date(now - 2000).toISOString() }],
    ['malformed time', { checkedAt: 'unknown' }],
  ])('rejects a renewal with %s', (_name, patch) => {
    const value = fixture(), payload = { ...value.payload, ...patch };
    expect(() => verify({ ...value, renewalRaw: renewal(payload), now })).toThrow('time_invalid');
  });

  it('rejects missing or forged MACs and changed encrypted journal bytes', () => {
    const value = fixture();
    expect(() => verify({ ...value, renewalRaw: JSON.stringify({ payload: value.payload }), now })).toThrow('mac_required');
    expect(() => verify({ ...value, renewalRaw: JSON.stringify({ payload: value.payload, mac: '00'.repeat(32) }), now })).toThrow('mac_invalid');
    expect(() => verify({ ...value, journalRaw: `${value.journalRaw}-changed`, renewalRaw: renewal(value.payload), now })).toThrow('hash_mismatch');
  });

  it('requires the renewal capability and an existing journal without creating either', () => {
    const value = fixture();
    expect(() => verify({ ...value, journalRaw: undefined, renewalRaw: renewal(value.payload), now })).toThrow('renewal_not_enabled');
    expect(() => verify({ ...value, approvalRaw: JSON.stringify({ ...value.approval, allowReadOnlyFreshnessRenewal: false }), renewalRaw: renewal(value.payload), now })).toThrow('renewal_not_enabled');
  });
});
