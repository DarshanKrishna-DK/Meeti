import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, keccak256, recoverTransactionAddress, serializeTransaction, type Address, type Hex } from 'viem';
import { prepareConditionalDemoAgentIdentityStep, type DemoIdentityOwnerReview } from '../scripts/prepare-demo-agent-identity';
import { ERC8004_SEPOLIA, identityRegistryAbi } from '../packages/ens/agent-identity';
import { agentRegistrationKey, publicAgentContextSchema, readRegistrationDataUri, registrationDataUri } from '../packages/ens/agent-records';
import { dnsEncode } from '../packages/ens';
import { resolverAbi } from '../packages/ens/abi';
import { admitIdentityBroadcast, assertIdentityAdmission, assertIdentityApiQuote, assertIdentityRaw, ensureIdentityReceiptDepth, safeIdentityErrorCodes, selectIdentityReconciliation, type IdentityJournalEntry, type IdentityQuote } from '../scripts/execute-demo-agent-identity';

// Receipt and provider methods are fixtures. These tests verify binding and exact public payloads, not live chain success.
const owner = '0x1111111111111111111111111111111111111111' as Address;
const delegate = '0x2222222222222222222222222222222222222222' as Address;
const resolver = '0x3333333333333333333333333333333333333333' as Address;
const registrationHash = `0x${'a'.repeat(64)}` as Hex;
const identity = { chainId: 11155111, registry: ERC8004_SEPOLIA.registry, agentId: '18446744073709551617' };
type Input = Parameters<typeof prepareConditionalDemoAgentIdentityStep>[0];
function fixture() {
  const review: DemoIdentityOwnerReview = { label: 'demo-seeker', owner, delegate, ensName: 'networking.demo-seeker.users.meeti-demo.eth', resolver,
    publicContext: publicAgentContextSchema.parse({ type: 'meeti-agent-context-v1', ensName: 'networking.demo-seeker.users.meeti-demo.eth', name: 'Meeti demo-seeker test agent', description: 'Fictional networking test. World verification is paused.', capabilities: ['discover', 'evaluate'], endpoints: [] }),
    registrationPrepared: { chainId: 11155111, from: owner, to: ERC8004_SEPOLIA.registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register' }), value: '0x0', operation: 'register-identity', ensName: 'networking.demo-seeker.users.meeti-demo.eth', blockNumber: '100', warning: 'Fixture only.' },
    maxGasCostWeiPerOperation: '500000000000000', totalMaxGasCostWei: '2000000000000000' };
  const context = publicAgentContextSchema.parse({ ...review.publicContext, registration: identity });
  const confirm = vi.fn(async () => ({ confirmed: true, chainId: 11155111, transactionHash: registrationHash, blockNumber: '123', identity, associationVerified: false, currentReadbackRequired: true }));
  const records = vi.fn(async () => ({ owner, resolver, records: { 'agent-context': JSON.stringify(context) } }));
  const publicPrepare = vi.fn(async (input: { ensName: string; owner: string; key: string; value: string }) => ({ chainId: 11155111, from: owner, to: resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(input.ensName), input.key, input.value] }), value: '0x0', operation: 'set-public-agent-record', ensName: input.ensName }));
  const uriPrepare = vi.fn(async (input: { identity: typeof identity; document: Parameters<typeof registrationDataUri>[0] }) => ({ chainId: 11155111, from: owner, to: ERC8004_SEPOLIA.registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: 'setAgentURI', args: [BigInt(input.identity.agentId), registrationDataUri(input.document)] }), value: '0x0', operation: 'set-identity-uri', ensName: review.ensName }));
  const association = vi.fn(async () => ({ identity, ensName: review.ensName, owner, key: agentRegistrationKey(identity), value: '1' }));
  const input = { review, registrationHash, ens: { readPublicAgentRecords: records, preparePublicAgentRecord: publicPrepare } as unknown as Input['ens'], identity: { confirmTransaction: confirm, prepareTransaction: uriPrepare, prepareAssociationRecord: association } as unknown as Input['identity'] };
  return { review, context, input, confirm, records, publicPrepare, uriPrepare, association };
}
describe('conditional fictional agent identity review guards', () => {
  it('derives the ID only through the exact reviewed registration confirmation and serializes API-equivalent context', async () => {
    const f = fixture(), result = await prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'publish-context' });
    expect(f.confirm).toHaveBeenCalledWith({ hash: registrationHash, prepared: f.review.registrationPrepared });
    expect(result.identity.agentId).toBe(identity.agentId); expect(result.authorityVerified).toBe(false); expect(result.humanVerified).toBe(false);
    const decoded = decodeFunctionData({ abi: resolverAbi, data: result.transaction.data });
    expect(decoded.functionName).toBe('setText'); expect(decoded.args).toEqual([dnsEncode(f.review.ensName), 'agent-context', JSON.stringify(f.context)]);
    expect(result.context.endpoints).toEqual([]); expect(result.context.registration).toEqual(identity);
  });
  it('does not accept an injected caller agent ID or private document as the registration source', async () => {
    const f = fixture(), injected = { ...f.input, operation: 'publish-context' as const, agentId: '999', document: { privateFile: 'Never publish this.' } };
    const result = await prepareConditionalDemoAgentIdentityStep(injected);
    expect(result.identity.agentId).toBe(identity.agentId); expect(JSON.stringify(result.document)).not.toContain('Never publish');
  });
  it('encodes ENS-only registry metadata from the fixed public fields and confirmed tuple', async () => {
    const f = fixture(), result = await prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'set-identity-uri' });
    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: result.transaction.data });
    expect(decoded.functionName).toBe('setAgentURI');
    if (decoded.functionName !== 'setAgentURI') throw new Error('unexpected_fixture_function');
    expect(decoded.args[0]).toBe(BigInt(identity.agentId));
    expect(readRegistrationDataUri(decoded.args[1])).toEqual({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: f.review.publicContext.name, description: f.review.publicContext.description,
      services: [{ name: 'ENS', endpoint: f.review.ensName, version: 'v2' }], x402Support: false, active: true, registrations: [{ agentId: identity.agentId, agentRegistry: `eip155:11155111:${ERC8004_SEPOLIA.registry}` }], supportedTrust: [] });
  });
  it('prepares the exact chain-specific ERC-7930 attestation only after current metadata verification', async () => {
    const f = fixture(), result = await prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'attest-association' });
    expect(f.association).toHaveBeenCalledWith({ identity, ensName: f.review.ensName, owner });
    const decoded = decodeFunctionData({ abi: resolverAbi, data: result.transaction.data });
    expect(decoded.args).toEqual([dnsEncode(f.review.ensName), agentRegistrationKey(identity), '1']);
  });
  it('blocks a guessed, malformed or substituted registry identity even if a fixture reports confirmation', async () => {
    for (const substitute of [{ ...identity, chainId: 1 }, { ...identity, registry: owner }, { ...identity, agentId: '01' }]) {
      const f = fixture(); f.confirm.mockResolvedValue({ confirmed: true, identity: substitute } as never);
      await expect(prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'publish-context' })).rejects.toThrow('canonical_registered_event_identity_required');
      expect(f.publicPrepare).not.toHaveBeenCalled();
    }
  });
  it('propagates canonical event, ownership or reorg verification failure without preparing any subsequent step', async () => {
    for (const reason of ['identity_registered_event_mismatch', 'identity_owner_mismatch', 'identity_transaction_reorganized']) {
      const f = fixture(); f.confirm.mockRejectedValue(new Error(reason));
      await expect(prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'publish-context' })).rejects.toThrow(reason);
      expect(f.publicPrepare).not.toHaveBeenCalled(); expect(f.uriPrepare).not.toHaveBeenCalled();
    }
  });
  it('requires exact current receipt-bound context before URI or attestation preparation', async () => {
    for (const operation of ['set-identity-uri', 'attest-association'] as const) {
      const f = fixture(); f.records.mockResolvedValue({ owner, resolver, records: { 'agent-context': '{}' } });
      await expect(prepareConditionalDemoAgentIdentityStep({ ...f.input, operation })).rejects.toThrow('reviewed_receipt_bound_context_not_confirmed');
      expect(f.uriPrepare).not.toHaveBeenCalled(); expect(f.association).not.toHaveBeenCalled();
    }
  });
  it('rejects altered reviewed registration calldata or budgets before reading any receipt', async () => {
    const f = fixture(); f.review.registrationPrepared.data = '0xdeadbeef';
    await expect(prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'publish-context' })).rejects.toThrow('identity_review_registration_scope_mismatch');
    expect(f.confirm).not.toHaveBeenCalled();
    const other = fixture(); other.review.totalMaxGasCostWei = '999' as never;
    await expect(prepareConditionalDemoAgentIdentityStep({ ...other.input, operation: 'publish-context' })).rejects.toThrow('identity_review_budget_mismatch');
  });
  it('rejects provider preparation that substitutes any conditional calldata despite the same sender and target', async () => {
    const f = fixture();
    f.publicPrepare.mockResolvedValue({ chainId: 11155111, from: owner, to: resolver, data: '0xdead', value: '0x0', operation: 'set-public-agent-record', ensName: f.review.ensName });
    await expect(prepareConditionalDemoAgentIdentityStep({ ...f.input, operation: 'publish-context' })).rejects.toThrow('conditional_identity_transaction_scope_mismatch');
  });
});

const clockNow = Date.parse('2026-11-07T00:00:00.000Z');
const reviewExpiresAt = '2026-11-07T00:20:00.000Z', quoteExpiresAt = '2026-11-07T00:10:00.000Z';
function quoteFixture() {
  const f = fixture(), operation: Parameters<typeof assertIdentityApiQuote>[0]['operation'] = { id: 'demo-seeker-publish-context', label: 'demo-seeker', operation: 'publish-context', chainId: 11155111, from: owner, to: resolver, valueWei: '0', maxGasCostWei: '500000000000000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', dependsOn: ['demo-seeker-register-identity'], data: null };
  const transaction = { chainId: 11155111, from: owner, to: resolver, data: '0x1234' as Hex, value: '0x0', ensName: f.review.ensName, gas: '0x186a0' as Hex, gasPrice: '0x2' as Hex };
  const quote: IdentityQuote = { operationId: '00000000-0000-4000-8000-000000000001', expiresAt: quoteExpiresAt, maxFeeWei: '500000000000000', transaction };
  return { quote, owner: f.review, operation, expected: transaction, reviewExpiresAt, now: clockNow };
}
describe('identity executor admission and immutable signed guards without network or wallet signing', () => {
  it('targets only an existing signed reconciliation entry and preserves all other journal states', () => {
    const q = quoteFixture(), raw = '0x1234' as Hex;
    const prior: IdentityJournalEntry = { id: 'demo-seeker-register-identity', label: 'demo-seeker', state: 'confirmed' };
    const target: IdentityJournalEntry = { id: q.operation.id, label: 'demo-seeker', state: 'submitted', raw, hash: keccak256(raw), quote: q.quote };
    const entries = [prior, target], before = JSON.stringify(entries), operations = [q.operation];
    expect(selectIdentityReconciliation('reconcile', target.id, operations, entries)).toEqual([q.operation]);
    expect(JSON.stringify(entries)).toBe(before);
    expect(selectIdentityReconciliation('execute', undefined, operations, entries)).toBe(operations);
    expect(() => selectIdentityReconciliation('execute', target.id, operations, entries)).toThrow('only_allowed_for_reconcile');
    expect(() => selectIdentityReconciliation('inspect', target.id, operations, entries)).toThrow('only_allowed_for_reconcile');
    expect(() => selectIdentityReconciliation('reconcile', 'unknown', operations, entries)).toThrow('existing_exact_signed_hash');
    expect(() => selectIdentityReconciliation('reconcile', target.id, operations, [prior, { ...target, raw: undefined }])).toThrow('existing_exact_signed_hash');
    expect(() => selectIdentityReconciliation('reconcile', target.id, operations, [prior, { ...target, hash: registrationHash }])).toThrow('existing_exact_signed_hash');
    expect(() => selectIdentityReconciliation('reconcile', target.id, operations, [{ ...prior, state: 'submitted' }, target])).toThrow('dependencies_unconfirmed');
  });
  it('extracts bounded numeric nested HTTP and RPC codes without exposing messages, URLs, data or cycles', () => {
    const error = { status: 429, message: 'secret https://private.example/key', data: { status: 500, code: -1 }, cause: { code: -32005, response: { statusCode: 503 }, error: { code: 3 } } };
    (error as unknown as { error: unknown }).error = error;
    const result = safeIdentityErrorCodes(error);
    expect(result).toEqual({ httpStatuses: [429, 503], rpcCodes: [-32005, 3] });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|key|data|500/);
    expect(safeIdentityErrorCodes({ status: '429', code: 'secret', cause: { code: 123456789, status: 999 } })).toEqual({ httpStatuses: [], rpcCodes: [] });
  });
  it('awaits the second confirmation even when the first receipt is already visible, preserving the same transaction hash', async () => {
    const receipt = { transactionHash: registrationHash, blockNumber: 100n }, wait = vi.fn(async () => receipt);
    expect(await ensureIdentityReceiptDepth({ receipt, headNumber: 100n, wait })).toEqual(receipt); expect(wait).toHaveBeenCalledOnce();
    wait.mockClear(); expect(await ensureIdentityReceiptDepth({ receipt, headNumber: 101n, wait })).toBe(receipt); expect(wait).not.toHaveBeenCalled();
    await expect(ensureIdentityReceiptDepth({ receipt, headNumber: 100n, wait: async () => ({ ...receipt, transactionHash: `0x${'b'.repeat(64)}` as Hex }) })).rejects.toThrow('confirmation_wait_hash_changed');
  });
  it('rejects review or API quote expiry, including expiry reached after a slow preflight', () => {
    expect(() => assertIdentityAdmission({ reviewExpiresAt, quoteExpiresAt }, clockNow)).not.toThrow();
    expect(() => assertIdentityAdmission({ reviewExpiresAt, quoteExpiresAt }, Date.parse(quoteExpiresAt))).toThrow('identity_api_quote_expired');
    expect(() => assertIdentityAdmission({ reviewExpiresAt, quoteExpiresAt }, Date.parse(reviewExpiresAt))).toThrow('identity_review_expired');
  });
  it('binds the quote to exact owner, target, calldata and original money cap', () => {
    const f = quoteFixture(); expect(assertIdentityApiQuote(f).maximumFeeWei).toBe(200000n);
    for (const change of [{ from: delegate }, { to: delegate }, { data: '0xdead' as Hex }, { value: '0x1' }, { chainId: 1 }]) expect(() => assertIdentityApiQuote({ ...f, quote: { ...f.quote, transaction: { ...f.quote.transaction, ...change } } })).toThrow('identity_api_quote_differs');
    expect(() => assertIdentityApiQuote({ ...f, quote: { ...f.quote, transaction: { ...f.quote.transaction, gasPrice: '0x1dcd6501' } } })).toThrow('fee_cap_exceeded');
    expect(() => assertIdentityApiQuote({ ...f, quote: { ...f.quote, expiresAt: undefined as never } })).toThrow('quote_expiry_required');
  });
  it('persists one-shot broadcast admission before sending, and never repeats a timed-out attempt', async () => {
    const q = quoteFixture(), raw = '0x1234' as Hex;
    const entry: IdentityJournalEntry = { id: q.operation.id, label: 'demo-seeker', state: 'signed', quote: q.quote, raw, hash: keccak256(raw) };
    const events: string[] = [], send = vi.fn(async () => { events.push('send'); throw new Error('fixture_timeout'); });
    await expect(admitIdentityBroadcast(entry, reviewExpiresAt, () => { events.push('durable-admission'); }, send, () => clockNow)).rejects.toThrow('fixture_timeout');
    expect(events).toEqual(['durable-admission', 'send']); expect(entry.broadcastAttemptedAt).toBeTruthy();
    await expect(admitIdentityBroadcast(entry, reviewExpiresAt, () => {}, send, () => clockNow)).rejects.toThrow('cannot_broadcast_again'); expect(send).toHaveBeenCalledOnce();
  });
  it('does not send when the quote expires during durable admission or the raw hash changes', async () => {
    const q = quoteFixture(), raw = '0x1234' as Hex;
    const entry: IdentityJournalEntry = { id: q.operation.id, label: 'demo-seeker', state: 'signed', quote: q.quote, raw, hash: keccak256(raw) };
    const send = vi.fn(), now = vi.fn().mockReturnValueOnce(clockNow).mockReturnValue(Date.parse(quoteExpiresAt));
    await expect(admitIdentityBroadcast(entry, reviewExpiresAt, () => {}, send, now)).rejects.toThrow('quote_expired'); expect(send).not.toHaveBeenCalled();
    entry.state = 'signed'; entry.broadcastAttemptedAt = undefined; entry.hash = registrationHash;
    await expect(admitIdentityBroadcast(entry, reviewExpiresAt, () => {}, send, () => clockNow)).rejects.toThrow('hash_changed'); expect(send).not.toHaveBeenCalled();
  });
  it('parses static signature components to verify immutable sender, zero value and fee envelope without any signing primitive', async () => {
    const q = quoteFixture();
    // These public numeric signature components are serializer fixtures. No wallet key or signing function is used.
    const raw = serializeTransaction({ type: 'legacy', chainId: 11155111, nonce: 5, to: resolver, data: q.quote.transaction.data, value: 0n, gas: 100000n, gasPrice: 2n }, { r: '0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', s: `0x${'0'.repeat(63)}1`, v: 27n });
    const recovered = await recoverTransactionAddress({ serializedTransaction: raw });
    const reviewedOwner = { ...q.owner, owner: recovered }, operation = { ...q.operation, from: recovered };
    const quote = { ...q.quote, transaction: { ...q.quote.transaction, from: recovered } };
    const entry: IdentityJournalEntry = { id: operation.id, label: 'demo-seeker', state: 'signed', quote, raw, hash: keccak256(raw), nonce: 5, reservedFeeWei: '200000' };
    await expect(assertIdentityRaw(entry, operation, reviewedOwner)).resolves.toBeUndefined();
    await expect(assertIdentityRaw(entry, { ...operation, to: delegate }, reviewedOwner)).rejects.toThrow('signed_scope_mismatch');
    await expect(assertIdentityRaw(entry, operation, q.owner)).rejects.toThrow('signed_scope_mismatch');
    await expect(assertIdentityRaw(entry, { ...operation, maxGasCostWei: '1' }, reviewedOwner)).rejects.toThrow('signed_fee_cap_mismatch');
  });
});
