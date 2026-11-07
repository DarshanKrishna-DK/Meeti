import { describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { admitEventBroadcast, admitEventDeadline, assertEventEnvelope, assertEventRaw, eventRemaining, validateEventApproval, type EventEntry } from '../scripts/event-demo-execute';

const owner = ('0x' + '11'.repeat(20)) as Address, recipient = ('0x' + '22'.repeat(20)) as Address;
function signed(): EventEntry { const raw = '0x010203' as Hex; return { id: 'fixture', state: 'signed', raw, hash: keccak256(raw) }; }
describe('event execution safety boundaries with offline fixtures', () => {
  it('checks both review and quote deadlines before any signing or admission', () => {
    const future = new Date(Date.now() + 60000).toISOString(), expired = new Date(Date.now() - 1).toISOString();
    expect(() => admitEventDeadline(expired)).toThrow('event_review_expired');
    expect(() => admitEventDeadline(future, expired)).toThrow('event_quote_expired');
    expect(() => admitEventDeadline('not-a-date')).toThrow(); expect(() => admitEventDeadline(future, future)).not.toThrow();
  });
  it('durably admits only once and never resends after an ambiguous network failure', async () => {
    const entry = signed(), trace: string[] = [];
    const send = vi.fn(async () => { trace.push('send'); throw new Error('fixture timeout with unknown outcome'); });
    const save = () => { trace.push('persist'); expect(entry.state).toBe('broadcast_admitted'); expect(entry.broadcastAttemptedAt).toBeTruthy(); };
    await expect(admitEventBroadcast(entry, new Date(Date.now() + 60000).toISOString(), save, send)).rejects.toThrow('fixture timeout');
    expect(trace).toEqual(['persist', 'send']);
    await expect(admitEventBroadcast(entry, new Date(Date.now() + 60000).toISOString(), save, send)).rejects.toThrow('event_unknown_or_previous_broadcast'); expect(send).toHaveBeenCalledOnce();
  });
  it('does not send if durable admission fails or its deadline passes during persistence', async () => {
    const send = vi.fn(async () => '0x00' as Hex);
    await expect(admitEventBroadcast(signed(), new Date(Date.now() + 60000).toISOString(), () => { throw new Error('disk fixture'); }, send)).rejects.toThrow('disk fixture');
    const entry = signed(), expiry = new Date(Date.now() + 1000).toISOString();
    const clock = vi.spyOn(Date, 'now');
    try { await expect(admitEventBroadcast(entry, expiry, () => { clock.mockReturnValue(Date.parse(expiry) + 1); }, send)).rejects.toThrow('event_review_expired'); }
    finally { clock.mockRestore(); }
    expect(send).not.toHaveBeenCalled();
  });
  it('retains unknown reserved fees, counts transfer value and isolates networks and senders', () => {
    const envelope = { chainId: 11155111, from: owner, to: recipient, data: '0x' as Hex, valueWei: '10', nonce: 0, gas: '1', maxFeePerGas: '5', maxPriorityFeePerGas: '1', maxFeeWei: '5' };
    const entries: EventEntry[] = [{ id: 'unknown', state: 'signing', envelope }, { id: 'known', state: 'confirmed', envelope, receipt: { blockNumber: '1', blockHash: '0x00', actualFeeWei: '2' } }, { id: 'other-network', state: 'signing', envelope: { ...envelope, chainId: 7794095 } }];
    expect(eventRemaining(100n, entries, owner, 11155111)).toBe(73n);
    expect(eventRemaining(100n, entries, owner, 11155111, 'unknown')).toBe(88n);
    expect(eventRemaining(100n, entries, recipient, 11155111)).toBe(100n);
  });
  it('validates real signed fixture fields without any RPC or broadcast', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 11155111, to: recipient, data: '0x', value: 10n, nonce: 1, gas: 21000n, maxFeePerGas: 5n, maxPriorityFeePerGas: 1n });
    const entry: EventEntry = { id: 'offline-fixture-only', state: 'signed', raw, hash: keccak256(raw), envelope: { chainId: 11155111, from: account.address, to: recipient, data: '0x', valueWei: '10', nonce: 1, gas: '21000', maxFeePerGas: '5', maxPriorityFeePerGas: '1', maxFeeWei: '105000' } };
    await expect(assertEventRaw(entry)).resolves.toBeUndefined(); entry.envelope!.nonce = 2; await expect(assertEventRaw(entry)).rejects.toThrow('event_signed_scope_changed');
  });
  it('rejects envelope changes, higher fees and gas units beyond the reviewed cap', () => {
    const operation: Parameters<typeof assertEventEnvelope>[1] = { id: 'offline', kind: 'funding', chainId: 11155111, from: owner, to: recipient, data: '0x', valueWei: '10', gasLimit: '21000', maxGasCostWei: '20000000', dependsOn: [] };
    const entry: EventEntry = { id: 'offline', state: 'signing', envelope: { chainId: 11155111, from: owner, to: recipient, data: '0x', valueWei: '10', nonce: 0, gas: '21000', maxFeePerGas: '5', maxPriorityFeePerGas: '1', maxFeeWei: '105000' } };
    expect(() => assertEventEnvelope(entry, operation)).not.toThrow(); entry.envelope!.valueWei = '11'; expect(() => assertEventEnvelope(entry, operation)).toThrow('event_envelope_review_scope_changed'); entry.envelope!.valueWei = '10'; entry.envelope!.gas = '22000'; entry.envelope!.maxFeeWei = '110000'; expect(() => assertEventEnvelope(entry, operation)).toThrow('event_envelope_gas_limit_exceeded');
  });
  it('requires exact review hash, owner caps and funding-only scope, never publication approval', () => {
    const review = { ens: { ownerCaps: [{ owner, totalMaxGasWei: '4450000000000000' }, { owner: recipient, totalMaxGasWei: '4450000000000000' }] } } as Parameters<typeof validateEventApproval>[0];
    const approved = { authorized: true, reviewSha256: 'a'.repeat(64), approvedAt: new Date().toISOString(), scope: 'event-names-identities-and-rabdi-funding-only', issuerSepoliaCapWei: '14421000000000000', issuerRabdiCapWei: '50000000000000000', ownerSepoliaCaps: { [owner]: '4450000000000000', [recipient]: '4450000000000000' } };
    expect(() => validateEventApproval(review, 'a'.repeat(64), approved)).not.toThrow();
    expect(() => validateEventApproval(review, 'b'.repeat(64), approved)).toThrow();
    expect(() => validateEventApproval(review, 'a'.repeat(64), { ...approved, scope: 'all-publications' })).toThrow();
    expect(() => validateEventApproval(review, 'a'.repeat(64), { ...approved, ownerSepoliaCaps: { [owner]: '9999999999999999', [recipient]: '4450000000000000' } })).toThrow();
  });
});
