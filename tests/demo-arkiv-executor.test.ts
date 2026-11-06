import { describe, expect, it, vi } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { assertAdmissionDeadline, assertNeverSignedRefresh, broadcastOnce, checkpointCanonicalReceipt, observeFundingBalance,
  signWithFreshAdmission, type Entry } from '../scripts/execute-demo-arkiv';

// Admission/state fixtures only. No wallet, signature generation, RPC, account or chain write is used.
const instant = (milliseconds: number) => new Date(milliseconds).toISOString();
const raw: Hex = '0x1234', rawHash = keccak256(raw);
function publication(): Entry {
  return { id: 'job:demo-seeker', label: 'demo-seeker', kind: 'publication', state: 'signed', raw, hash: rawHash,
    prepared: { expiresAt: instant(5000) } as NonNullable<Entry['prepared']> };
}
function funding(): Entry {
  return { id: 'fund:demo-seeker', label: 'demo-seeker', kind: 'funding', state: 'confirmed', raw, hash: rawHash,
    receipt: { blockNumber: '1', blockHash: `0x${'11'.repeat(32)}`, actualFeeWei: '21000' } };
}

describe('Arkiv executor admission and recovery with fixture callbacks', () => {
  it('does not sign when the quote expires during the final ENS await', async () => {
    let clock = 1000;
    const sign = vi.fn(async () => raw), rabdi = vi.fn(async () => {});
    await expect(signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: instant(10000), quoteExpiresAt: instant(2000), now: () => clock,
      refreshEns: async () => { clock = 2000; }, refreshRabdi: rabdi, sign })).rejects.toThrow('publication_quote_expired');
    expect(sign).not.toHaveBeenCalled(); expect(rabdi).not.toHaveBeenCalled();
  });
  it('runs the final Rabdi preflight after ENS and signs only while both deadlines remain current', async () => {
    const order: string[] = [];
    const result = await signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: instant(10000), quoteExpiresAt: instant(5000), now: () => 1000,
      refreshEns: async () => { order.push('ens'); }, refreshRabdi: async () => { order.push('rabdi'); }, sign: async () => { order.push('sign'); return raw; } });
    expect(order).toEqual(['ens', 'rabdi', 'sign']); expect(result).toBe(raw);
  });
  it('does not sign when the quote expires during the final Rabdi preflight', async () => {
    let clock = 1000; const sign = vi.fn(async () => raw);
    await expect(signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: instant(10000), quoteExpiresAt: instant(2000), now: () => clock,
      refreshEns: async () => {}, refreshRabdi: async () => { clock = 2001; }, sign })).rejects.toThrow('publication_quote_expired');
    expect(sign).not.toHaveBeenCalled();
  });
  it.each(['ens', 'rabdi'] as const)('does not sign after a %s read failure', async failed => {
    const sign = vi.fn(async () => raw);
    await expect(signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: instant(10000), quoteExpiresAt: instant(5000), now: () => 1000,
      refreshEns: async () => { if (failed === 'ens') throw new Error('Fixture provider failure'); },
      refreshRabdi: async () => { if (failed === 'rabdi') throw new Error('Fixture provider failure'); }, sign })).rejects.toThrow('Fixture provider failure');
    expect(sign).not.toHaveBeenCalled();
  });
  it('requires a finite current quote for publications while funding still requires the review deadline', () => {
    expect(() => assertAdmissionDeadline({ kind: 'publication', reviewExpiresAt: instant(10000) }, 1000)).toThrow('publication_quote_expired');
    expect(() => assertAdmissionDeadline({ kind: 'funding', reviewExpiresAt: instant(1000) }, 1000)).toThrow('review_expired');
    expect(() => assertAdmissionDeadline({ kind: 'publication', reviewExpiresAt: instant(10000), quoteExpiresAt: 'invalid' }, 1000)).toThrow('publication_quote_expired');
  });
  it('durably admits exactly one first send and rejects rebroadcast after an unknown response', async () => {
    const entry = publication(), phases: string[] = [];
    const save = vi.fn(() => { phases.push(entry.state); });
    const send = vi.fn(async () => { expect(phases).toEqual(['broadcast_admitted']); throw new Error('Fixture lost response'); });
    await expect(broadcastOnce(entry, instant(10000), save, send, () => 1000)).rejects.toThrow('Fixture lost response');
    expect(entry.state).toBe('broadcast_admitted'); expect(entry.broadcastAttemptedAt).toBe(instant(1000)); expect(entry.hash).toBe(rawHash);
    await expect(broadcastOnce(entry, instant(10000), save, send, () => 1001)).rejects.toThrow('cannot_be_broadcast_again');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects an expired quote after the durable admission checkpoint without forwarding bytes', async () => {
    let clock = 1000; const entry = publication(), send = vi.fn(async () => rawHash);
    await expect(broadcastOnce(entry, instant(10000), () => { clock = 5000; }, send, () => clock)).rejects.toThrow('publication_quote_expired');
    expect(send).not.toHaveBeenCalled(); expect(entry.state).toBe('broadcast_admitted'); expect(entry.hash).toBe(rawHash);
  });
  it('does not forward a send if the durable admission checkpoint fails', async () => {
    const entry = publication(), send = vi.fn(async () => rawHash);
    await expect(broadcastOnce(entry, instant(10000), () => { throw new Error('Fixture disk failure'); }, send, () => 1000)).rejects.toThrow('Fixture disk failure');
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves the original known hash when the provider returns a different hash', async () => {
    const entry = publication();
    await expect(broadcastOnce(entry, instant(10000), () => {}, async () => `0x${'22'.repeat(32)}`, () => 1000)).rejects.toThrow('hash_mismatch');
    expect(entry.hash).toBe(rawHash); expect(entry.state).toBe('broadcast_admitted');
  });
  it('retains canonical funding confirmation after legitimate use lowers the current balance', async () => {
    const entry = funding(); checkpointCanonicalReceipt(entry, entry.receipt!);
    await observeFundingBalance(entry, async () => 19_000_000_000_000_000n, 1000);
    expect(entry.state).toBe('confirmed'); expect(entry.balanceObservation).toMatchObject({ status: 'observed', balanceWei: '19000000000000000' });
  });
  it('retains prior confirmed state and canonical fee on a later balance-read failure', async () => {
    const entry = funding(); checkpointCanonicalReceipt(entry, entry.receipt!);
    await observeFundingBalance(entry, async () => { throw new Error('Fixture RPC unavailable'); }, 1000);
    expect(entry.state).toBe('confirmed'); expect(entry.receipt?.actualFeeWei).toBe('21000'); expect(entry.balanceObservation).toMatchObject({ status: 'unavailable', balanceWei: null });
  });
  it('keeps an unverified receipt checkpoint separate from a fully confirmed record', () => {
    const entry = funding(); entry.state = 'submitted'; checkpointCanonicalReceipt(entry, entry.receipt!);
    expect(entry.state).toBe('receipt_confirmed');
  });
  it.each(['raw', 'hash', 'attempt', 'signed-state'] as const)('denies never-signed refresh with %s evidence', field => {
    const entry: Entry = { id: 'job:demo-seeker', label: 'demo-seeker', kind: 'publication', state: 'prepared', signature: '0x1234' };
    if (field === 'raw') entry.raw = raw;
    if (field === 'hash') entry.hash = rawHash;
    if (field === 'attempt') entry.broadcastAttemptedAt = instant(1000);
    if (field === 'signed-state') entry.state = 'signed';
    expect(() => assertNeverSignedRefresh(entry)).toThrow('definitively_never_signed');
  });
  it('permits explicit refresh validation only for the public-message-signed but never-transaction-signed state', () => {
    expect(() => assertNeverSignedRefresh({ id: 'job:demo-seeker', label: 'demo-seeker', kind: 'publication', state: 'prepared', signature: '0x1234' })).not.toThrow();
  });
});
