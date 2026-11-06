import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, getAddress, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { decrypt, encrypt } from '../packages/server/crypto';
import { createEnsAuthorityProvider, STATUS_KEY, TEXT_ROLE, textResource } from '../packages/ens';
import { resolverAbi } from '../packages/ens/abi';
import { buildNamespaceRepair } from '../packages/ens/namespace-repair';
import type { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';

type Plan = Awaited<ReturnType<typeof buildNamespaceDemoPlan>>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
async function main() {
  requireValue(!existsSync('.local-data/namespace-repair-approval.json'), 'approved_repair_is_immutable');
  const raw = readFileSync('artifacts/namespace-demo-review.json', 'utf8'), originalReviewSha256 = sha(raw);
  const original = JSON.parse(raw) as { chainId: number; parent: { issuer: Address }; plan: Plan };
  const originalApproval = JSON.parse(readFileSync('.local-data/namespace-demo-approval.json', 'utf8')) as { authorized: boolean; reviewSha256: string };
  requireValue(originalApproval.authorized && originalApproval.reviewSha256 === originalReviewSha256 && original.chainId === 11155111, 'original_approval_scope_mismatch');
  const issuer = getAddress(original.parent.issuer);
  requireValue(same(issuer, '0x9253705482a44e6A7378163e57cc791AE6213ed5'), 'unexpected_issuer');
  const publicExecution = JSON.parse(readFileSync('artifacts/namespace-demo-execution.json', 'utf8')) as { reviewSha256: string; transactions: { id: string; hash: Hex; status: string; confirmed?: { blockNumber: string; blockHash: Hex } }[] };
  requireValue(publicExecution.reviewSha256 === originalReviewSha256 && publicExecution.transactions.length === 12 && publicExecution.transactions.slice(0, 11).every(tx => tx.status === 'confirmed_readback') && publicExecution.transactions[11].id === 'demo-seeker-grant', 'expected_stopped_namespace_checkpoint_required');
  const vaultPath = '.local-data/demo-delegates.enc', context = 'meeti-demo-delegates-v1';
  type Vault = { version: 1; createdAt: string; wallets: { label: string; owner: Address; privateKey: Hex }[] };
  if (!existsSync(vaultPath)) {
    const vault: Vault = { version: 1, createdAt: new Date().toISOString(), wallets: original.plan.recipients.map(r => ({ label: r.label, owner: r.owner, privateKey: generatePrivateKey() })) };
    mkdirSync('.local-data', { recursive: true }); writeFileSync(vaultPath, encrypt(vault, context), { flag: 'wx', mode: 0o600 });
  }
  const vault = decrypt<Vault>(readFileSync(vaultPath, 'utf8'), context);
  requireValue(vault.version === 1 && vault.wallets.length === 2, 'invalid_delegate_vault');
  const delegates = vault.wallets.map(wallet => ({ label: wallet.label, owner: getAddress(wallet.owner), address: privateKeyToAccount(wallet.privateKey).address }));
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/demo-delegates.json', JSON.stringify({ version: 1, fictional: true, humanVerified: false, delegates }, null, 2));
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  requireValue(rpcUrl, 'ens_rpc_not_configured');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) }), ens = createEnsAuthorityProvider({ rpcUrl });
  try {
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    requireValue(chainId === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_or_stale_head');
    const originalConfirmedDependencies = [];
    const originals = new Map([...JSON.parse(raw).funding, ...original.plan.operations].map(op => [op.id, op]));
    for (const entry of publicExecution.transactions) {
      const expected = originals.get(entry.id);
      requireValue(expected, 'unexpected_original_operation');
      const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash: entry.hash }), client.getTransaction({ hash: entry.hash })]);
      requireValue(receipt.status === 'success' && head.number >= receipt.blockNumber + 1n && (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, 'original_receipt_not_canonical');
      requireValue(same(transaction.from, expected.from) && transaction.to && same(transaction.to, expected.to) && same(transaction.input, expected.data) && transaction.value === BigInt(expected.valueWei ?? 0), 'original_transaction_mismatch');
      originalConfirmedDependencies.push({ id: entry.id, hash: entry.hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash });
    }
    const seeker = original.plan.recipients.find(r => r.label === 'demo-seeker')!;
    const oldGrant = originalConfirmedDependencies.find(tx => tx.id === 'demo-seeker-grant')!;
    const oldScope = await ens.inspectDelegateAncestors({ ensName: seeker.agentName, delegate: issuer });
    const oldAuthority = await ens.checkAuthority({ ensName: seeker.agentName, owner: seeker.owner, delegate: issuer, action: 'negotiate', policyVersion: '1', policyDigest: seeker.policyDigest });
    requireValue(!oldScope.allowed && !oldAuthority.allowed && oldAuthority.reason === 'delegate_ancestor_control_too_broad', 'expected_unsafe_issuer_delegate_denial_missing');
    const oldStatusRoles = await client.readContract({ address: seeker.resolver, abi: resolverAbi, functionName: 'roles', args: [textResource(STATUS_KEY), issuer] });
    requireValue(oldStatusRoles === TEXT_ROLE, 'mined_old_grant_scope_not_found');
    const scopeChecks: Awaited<ReturnType<typeof ens.inspectDelegateAncestors>>[] = [];
    const repair = await buildNamespaceRepair({ original: original.plan, issuer, delegates, assertDelegateScope: async input => {
      const checked = await ens.inspectDelegateAncestors({ ensName: input.ensName, delegate: input.delegate });
      requireValue(checked.allowed, 'replacement_delegate_has_ancestor_authority'); scopeChecks.push(checked);
    } });
    const livePreparations = [];
    for (const op of repair.operations.filter(op => op.recipientLabel === 'demo-seeker')) {
      const r = repair.recipients.find(r => r.label === op.recipientLabel)!;
      const delegate = op.adapterOperation === 'revoke' ? issuer : r.delegate;
      const prepared = await ens.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate, operation: op.adapterOperation!, ...(op.adapterOperation === 'set-policy' ? { value: JSON.stringify(r.proposedPublicPolicy) } : {}) });
      requireValue(same(prepared.from, op.from) && same(prepared.to, op.to) && same(prepared.data, op.data), 'live_repair_calldata_changed');
      const gas = await client.estimateGas({ account: op.from, to: op.to, data: op.data, value: 0n, maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas) });
      const current = await client.getBlock();
      const envelope = boundedFundingEnvelope({ estimatedGas: gas, maxGasCostWei: BigInt(op.maxGasCostWei), reviewedMaxFeePerGas: BigInt(op.maxFeePerGas), reviewedMaxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas), baseFeePerGas: current.baseFeePerGas ?? 0n });
      livePreparations.push({ id: op.id, actualCurrentStateSimulation: true, estimatedGas: gas.toString(), envelope: Object.fromEntries(Object.entries(envelope).map(([key, value]) => [key, value.toString()])), dependenciesStillRequireConfirmedReadback: true });
    }
    const recruiterRegistry = repair.operations.find(op => op.id === 'demo-recruiter-registry')!;
    const recruiter = repair.recipients.find(r => r.label === 'demo-recruiter')!;
    const registryPreparation = await ens.prepareProjectRecipientRegistry({ parentName: original.plan.branch, label: recruiter.label, issuer, recipient: recruiter.owner });
    requireValue(registryPreparation.needed && same(registryPreparation.to, recruiterRegistry.to) && same(registryPreparation.data, recruiterRegistry.data), 'unchanged_recruiter_registry_preparation_mismatch');
    const funding = [], totalCaps = { ...repair.gasCaps }, balances = [];
    for (const delegate of delegates) {
      const balance = await client.getBalance({ address: delegate.address });
      const code = await client.getCode({ address: delegate.address });
      requireValue(!code || code === '0x', 'new_delegate_must_be_eoa');
      const target = parseEther('0.001');
      if (balance < target) {
        const value = target - balance;
        funding.push({ id: `fund-${delegate.label}-delegate`, kind: 'fund-delegate', recipientLabel: delegate.label, chainId: 11155111, from: issuer, to: delegate.address, valueWei: value.toString(), data: '0x', gasLimit: '21000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '10500000000000', optionalPurpose: 'Only test ETH for separately approved future delegate status-write demonstrations.' });
        totalCaps[issuer] = (BigInt(totalCaps[issuer] ?? '0') + value + 10500000000000n).toString();
      }
    }
    for (const address of Object.keys(totalCaps)) balances.push({ address, balanceWei: (await client.getBalance({ address: address as Address })).toString(), requiredMaxWei: totalCaps[address] });
    const finalBlock = await client.getBlock(); requireValue(Math.abs(Date.now() / 1000 - Number(finalBlock.timestamp)) < 90, 'repair_review_head_stale');
    requireValue(sha(readFileSync('artifacts/namespace-demo-review.json', 'utf8')) === originalReviewSha256, 'original_review_changed_during_preparation');
    const report = { reviewOnly: true, approvalState: 'not_authorized_for_signature_or_broadcast', fictional: true, humanVerified: false, chainId: 11155111, checkedAt: new Date().toISOString(), reviewExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), originalReviewSha256, issuer,
      originalConfirmedDependencies, oldGrantReceipt: { ...oldGrant, canonical: true, statusRole: oldStatusRoles.toString(), applicationAuthorityAllowed: false, reason: oldAuthority.reason }, oldIssuerAncestorControl: oldScope,
      recipients: repair.recipients, operations: repair.operations, funding, gasCaps: repair.gasCaps, totalCaps, balances, scopeChecks, livePreparations,
      conditionalOperationIds: repair.operations.filter(op => op.recipientLabel !== 'demo-seeker').map(op => op.id), observedBlockNumber: finalBlock.number.toString(), observedBlockHash: finalBlock.hash,
      retainedPowers: ['Project issuer retains its original meeti-demo.eth and users.meeti-demo.eth ancestor powers. This repair does not emancipate names or alter those powers.', 'Each fictional owner retains exclusive root control of its recipient registry and dedicated resolver. Each separate agent key receives only the status-text setter role.', 'All local fictional owner and agent keys remain encrypted with the application encryption key. No MetaMask key is extracted. Agent status signatures and writes require separate bounded authorization.'],
      costExplanation: { seekerAdditionalOwnerGasWei: repair.gasCaps[seeker.owner], recruiterRemainingOwnerGasWei: repair.gasCaps[recruiter.owner], issuerRemainingStructuralGasWei: repair.gasCaps[issuer], optionalDelegateFundingAndFeesWei: funding.reduce((sum, tx) => sum + BigInt(tx.valueWei) + BigInt(tx.maxGasCostWei), 0n).toString(), fundingDoesNotAuthorizeStatusWrites: true },
      requirements: ['New bounded approval for this exact repair. The original approval is not substituted for changed policy or delegate calldata.', 'Reconcile the already mined seeker grant as canonical receipt plus denied authority. Do not mark the unsafe binding authorized or resubmit that transaction.', 'After owner revoke, verify issuer status role zero. Update policy v2 and its new digest; after exact grant, verify current authority with the independent low-privilege delegate.', 'Reprepare every operation against current state and enforce unchanged per-operation and total maximum money caps. Gas may be reestimated only by lowering fees to remain within each reviewed gas-cost budget.', 'Recruiter structural calldata remains identical to original reviewed operations. Its future policy and grant are replaced explicitly by this new review.', 'No ERC-8004, ENSIP-25, ENSIP-26, World verification, public deployment or status-write transaction is included.'], signaturesRequested: 0, transactionsSubmitted: 0 };
    const path = 'artifacts/namespace-repair-review.json', output = JSON.stringify(report, null, 2); writeFileSync(path, output);
    console.log(JSON.stringify({ path, reviewSha256: sha(output), checkedAt: report.checkedAt, operations: report.operations.length, fundingTransfers: funding.length, totalCaps, delegates, allCurrentlyFunded: balances.every(row => BigInt(row.balanceWei) >= BigInt(row.requiredMaxWei)), oldGrantCanonical: true, oldAuthorityDenied: oldAuthority.reason, signatures: 0, broadcasts: 0 }));
  } finally { await ens.disconnect(); const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> }; try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Provider credentials remain private. */ } }
}
await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_repair_preparation_failed_no_secret_details_logged'); process.exitCode = 1; });
