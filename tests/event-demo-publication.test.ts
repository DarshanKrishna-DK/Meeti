import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, stringToHex, toHex, type Hex } from 'viem';
import { ARKIV_NATIVE_ADDRESS, ARKIV_SCHEMA_NAME, canonicalIntent, intentDigest, intentSigningMessage, PublicIntents, type PreparedArkivTransaction } from '../packages/arkiv/src';
import { eventPublicDraft } from '../scripts/event-demo-review';
import { EVENT_ORIGIN, eventLabels } from '../scripts/event-demo-accounts';
import { admitEventPublication, assertEventCreateCalldata, assertEventPrepared, EVENT_PUBLICATION_FEE_CAP, validateEventPublicationApproval, validateEventPublicationJournal, validateEventPublicationReview,
  type EventPublicationEntry, type EventPublicationReview } from '../scripts/event-demo-publish';

// ABI, approval and journal fixtures only. These tests sign nothing and make no RPC or model requests.
const at = (time: number) => new Date(time).toISOString();
const now = Date.parse('2026-11-07T00:00:00.000Z'), head = { number: 1000n, gasLimit: 30000000n };
const signature = `0x${'00'.repeat(65)}` as Hex;
function fixtureReview(): EventPublicationReview {
  return { version: 1, reviewOnly: true, fictional: true, humanVerified: false, scope: 'event-krishna-viha-publications-only', origin: EVENT_ORIGIN, chainId: 7794095, sdkVersion: '1.0.1',
    createdAt: at(now - 1000), reviewExpiresAt: at(now + 1800000), previewSha256: 'a'.repeat(64), flowSourceDigest: 'b'.repeat(64),
    genesisHash: `0x${'77'.repeat(32)}`, observedBlock: '1000', observedBlockGasLimit: '30000000', observedGasPriceWei: '1000000000', maximumPublicationFeePerOwnerWei: '10000000000000000', publications: 2, fundingTransfers: 0,
    records: eventLabels.map((label, index) => {
      const owner = `0x${(index ? '22' : '11').repeat(20)}`, ensName = `networking.event-${label}.users.meeti-demo.eth`;
      const intent = canonicalIntent({ intentId: randomUUID(), ensAgentRef: ensName, goal: 'collaborator', tags: ['event'], summary: eventPublicDraft(label), visibility: 'public', optIn: true, schemaVersion: 2, status: 'active',
        semantics: { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborate', direction: 'collaborating', directionEvidence: 'want to collaborate', canonicalRole: { value: 'event organizers', sourceQuote: 'event organizers' }, topics: [], offers: [], requirements: [], clarificationQuestions: [] },
        owner, version: 1, policyVersion: 1, createdAt: at(now - 60000), expiresAt: at(now + 3600000), demoOrigin: true });
      return { label, accountId: randomUUID(), intent, payloadDigest: intentDigest(intent), signingMessage: intentSigningMessage(intent), balanceWei: '20000000000000000',
        ens: { ensName, owner, delegate: `0x${(index ? '44' : '33').repeat(20)}`, resolver: `0x${(index ? '66' : '55').repeat(20)}`, policyVersion: 1, policyDigest: `0x${'99'.repeat(32)}`, blockNumber: '12000000', checkedAt: at(now - 500) } };
    }) };
}
const executeAbi = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
const createParams = parseAbiParameters('(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)');
function calldata(record: EventPublicationReview['records'][number], change?: (wire: { expiresAt: bigint; minLifetime: bigint; creationFlags: number; attributes: { name: Hex; typeId: number; value: Hex }[] }) => void, operation = 1) {
  const p = canonicalIntent(record.intent);
  const values: Record<string, string | number | boolean> = { 'arkiv.schema': ARKIV_SCHEMA_NAME, intentId: p.intentId, ensAgentRef: p.ensAgentRef, goal: p.goal, visibility: 'public', optIn: true, owner: p.owner, version: 1, policyVersion: 1, schemaVersion: 2, status: 'active', direction: 'collaborating', category: 'collaborator', canonicalRole: 'event organizers', createdAt: Date.parse(p.createdAt), expiresAt: Date.parse(p.expiresAt), demoOrigin: true, envelope: JSON.stringify({ intent: p, signature }),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`tag${index}`, p.tags[index] ?? ''])) };
  const types: Record<string, number> = { bool: 1, u64: 3, bytes: 7, str: 8, addr: 9 };
  const attributes = Object.entries(values).map(([name, value]) => {
    const c = name === 'arkiv.schema' ? { type: 'str', isIndexed: true } : PublicIntents.columns[name as keyof typeof PublicIntents.columns];
    return { name: stringToHex(name, { size: 32 }), typeId: types[c.type] | (c.isIndexed ? 128 : 0),
      value: c.type === 'str' || c.type === 'bytes' ? stringToHex(String(value)) : toHex(c.type === 'bool' ? value ? 1n : 0n : BigInt(value), { size: 32 }) };
  });
  const wire = { expiresAt: 2800n, minLifetime: 0n, creationFlags: 1, attributes }; change?.(wire);
  const operationData = encodeAbiParameters(createParams, [{ salt: 123n, ...wire }]);
  return encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [[{ operation, operationData }]] });
}
function prepared(record: EventPublicationReview['records'][number]): PreparedArkivTransaction {
  return { chainId: 7794095, account: record.intent.owner as `0x${string}`, request: { from: record.intent.owner as `0x${string}`, to: ARKIV_NATIVE_ADDRESS, data: calldata(record), value: '0x0', chainId: '0x76edaf', gas: toHex(1000000n), gasPrice: toHex(1000000000n), nonce: '0x0', type: '0x0' },
    maximumFeeWei: '1000000000000000', preparedAt: at(now - 1000), expiresAt: at(now + 59000), intent: record.intent, payloadDigest: record.payloadDigest as Hex };
}
function approval(review: EventPublicationReview) { return { authorized: true, reviewSha256: 'c'.repeat(64), scope: review.scope, chainId: 7794095, approvedAt: at(now), maximumPublicationFeePerOwnerWei: '10000000000000000', publications: 2, fundingTransfers: 0 }; }

describe('bounded event publication fixtures, not live publication evidence', () => {
  it('requires two exact fictional event payloads, distinct owners and a separate zero-funding approval', () => {
    const review = fixtureReview(); expect(validateEventPublicationReview(review)).toEqual(review);
    expect(validateEventPublicationApproval(review, 'c'.repeat(64), approval(review), now)).toMatchObject({ publications: 2, fundingTransfers: 0 });
    for (const mutation of [(v: EventPublicationReview) => { v.records[1].label = 'krishna'; }, (v: EventPublicationReview) => { v.records[0].intent.summary += ' Added unapproved public fact'; }, (v: EventPublicationReview) => { v.records[0].balanceWei = '0'; }]) {
      const altered = structuredClone(review); mutation(altered); expect(() => validateEventPublicationReview(altered)).toThrow();
    }
    expect(() => validateEventPublicationReview({ ...review, fundingTransfers: 1 })).toThrow();
    expect(() => validateEventPublicationReview({ ...review, humanVerified: true })).toThrow();
    expect(() => validateEventPublicationApproval(review, 'd'.repeat(64), approval(review), now)).toThrow();
    expect(() => validateEventPublicationApproval(review, 'c'.repeat(64), { ...approval(review), fundingTransfers: 1 }, now)).toThrow();
    expect(() => validateEventPublicationApproval(review, 'c'.repeat(64), { ...approval(review), approvedAt: at(now + 1000) }, now)).toThrow();
  });
  it('validates every signed public attribute and denies duplicate, changed or hidden extra content', () => {
    const record = fixtureReview().records[0]; expect(() => assertEventCreateCalldata(calldata(record), record, signature, head, now)).not.toThrow();
    for (const mutate of [(w: Parameters<NonNullable<Parameters<typeof calldata>[1]>>[0]) => { w.attributes.push({ name: stringToHex('privateContact', { size: 32 }), typeId: 8, value: stringToHex('not approved') }); },
      (w: Parameters<NonNullable<Parameters<typeof calldata>[1]>>[0]) => { w.attributes[0] = w.attributes[1]; },
      (w: Parameters<NonNullable<Parameters<typeof calldata>[1]>>[0]) => { w.attributes.find(a => a.name === stringToHex('envelope', { size: 32 }))!.value = stringToHex('{}'); },
      (w: Parameters<NonNullable<Parameters<typeof calldata>[1]>>[0]) => { w.attributes.find(a => a.name === stringToHex('owner', { size: 32 }))!.value = toHex(0n, { size: 32 }); },
      (w: Parameters<NonNullable<Parameters<typeof calldata>[1]>>[0]) => { w.attributes.find(a => a.name === stringToHex('direction', { size: 32 }))!.typeId = 8; }]) {
      expect(() => assertEventCreateCalldata(calldata(record, mutate), record, signature, head, now)).toThrow();
    }
    expect(() => assertEventCreateCalldata(calldata(record, undefined, 4), record, signature, head, now)).toThrow('ONE_NATIVE_CREATE');
  });
  it.each(['mutable', 'permissionless-extension', 'relative-lifetime', 'too-long', 'already-expired'] as const)('denies %s creation lifetime or flags', mode => {
    const record = fixtureReview().records[0];
    const data = calldata(record, wire => { if (mode === 'mutable') wire.creationFlags = 0; if (mode === 'permissionless-extension') wire.creationFlags = 3; if (mode === 'relative-lifetime') wire.minLifetime = 1n; if (mode === 'too-long') wire.expiresAt = 999999n; if (mode === 'already-expired') wire.expiresAt = head.number; });
    expect(() => assertEventCreateCalldata(data, record, signature, head, now)).toThrow('FLAGS_OR_EXPIRY');
  });
  it('requires the actual prepared legacy native create, fresh quote, half-block gas and owner fee cap', () => {
    const record = fixtureReview().records[0], quote = prepared(record);
    expect(assertEventPrepared(record, signature, quote, head, now)).toMatchObject({ nonce: 0, valueWei: '0', maximumFeeWei: quote.maximumFeeWei });
    for (const mutate of [(p: PreparedArkivTransaction) => { p.request.value = '0x1' as '0x0'; }, (p: PreparedArkivTransaction) => { p.request.chainId = '0x1'; },
      (p: PreparedArkivTransaction) => { p.request.from = `0x${'aa'.repeat(20)}`; }, (p: PreparedArkivTransaction) => { p.expiresAt = at(now); },
      (p: PreparedArkivTransaction) => { p.request.gas = toHex(16000000n); p.maximumFeeWei = '16000000000000000'; }, (p: PreparedArkivTransaction) => { p.maximumFeeWei = '1'; }]) {
      const altered = structuredClone(quote); mutate(altered); expect(() => assertEventPrepared(record, signature, altered, head, now)).toThrow();
    }
  });
  it('journals admission before a single send and never retries an unknown response', async () => {
    const raw = '0x123456' as Hex, entry: EventPublicationEntry = { label: 'krishna', state: 'signed', raw, hash: keccak256(raw), prepared: prepared(fixtureReview().records[0]) };
    let durable: EventPublicationEntry | undefined;
    const send = vi.fn(async () => { expect(durable?.state).toBe('broadcast_admitted'); throw new Error('fixture lost response'); });
    await expect(admitEventPublication(entry, at(now + 100000), () => { durable = structuredClone(entry); }, send, () => now)).rejects.toThrow('fixture lost response');
    await expect(admitEventPublication(entry, at(now + 100000), () => {}, send, () => now)).rejects.toThrow('NO_RESEND');
    expect(send).toHaveBeenCalledOnce(); expect(entry.broadcastAttemptedAt).toBe(at(now));
  });
  it('does not send after expiry during the admission journal fsync boundary', async () => {
    let clock = now;
    const raw = '0x123456' as Hex, entry: EventPublicationEntry = { label: 'krishna', state: 'signed', raw, hash: keccak256(raw), prepared: prepared(fixtureReview().records[0]) }, send = vi.fn();
    await expect(admitEventPublication(entry, at(now + 100000), () => { clock = now + 60000; }, send, () => clock)).rejects.toThrow('quote_expired');
    expect(send).not.toHaveBeenCalled(); expect(entry.state).toBe('broadcast_admitted');
  });
  it('bounds aggregate owner scope and refuses duplicate labels or missing durable admission', () => {
    const review = fixtureReview(), hash = 'c'.repeat(64), entry: EventPublicationEntry = { label: 'krishna', state: 'prepared', prepared: prepared(review.records[0]) };
    expect(() => validateEventPublicationJournal(review, hash, { version: 1, reviewSha256: hash, entries: [entry] })).not.toThrow();
    expect(() => validateEventPublicationJournal(review, hash, { version: 1, reviewSha256: hash, entries: [entry, entry] })).toThrow('SCOPE_CHANGED');
    const excessive = structuredClone(entry); excessive.prepared!.maximumFeeWei = (EVENT_PUBLICATION_FEE_CAP + 1n).toString();
    expect(() => validateEventPublicationJournal(review, hash, { version: 1, reviewSha256: hash, entries: [excessive] })).toThrow('FEE_EXCEEDED');
    expect(() => validateEventPublicationJournal(review, hash, { version: 1, reviewSha256: hash, entries: [{ label: 'viha', state: 'submitted' }] })).toThrow('ADMISSION_REQUIRED');
  });
});
