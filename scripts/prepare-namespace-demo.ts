import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, getAddress, keccak256, parseEther, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, ENS_DEPLOYMENT, ENS_CHAIN_ID } from '../packages/ens';
import { factoryAbi, registryAbi } from '../packages/ens/abi';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';

// Read-only preparation. This script never imports accounts, wallet clients or the encrypted test key vault.
if (existsSync('.local-data/namespace-demo-approval.json')) throw new Error('approved_review_is_immutable_use_repair_preparation');
const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
if (!rpcUrl) throw new Error('ens_rpc_not_configured');
const issuer = getAddress('0x9253705482a44e6A7378163e57cc791AE6213ed5');
const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
const ens = createEnsAuthorityProvider({ rpcUrl });
try {
  const source = JSON.parse(readFileSync('artifacts/demo-wallets.json', 'utf8')) as { fictional: boolean; humanVerified: boolean; wallets: { label: string; address: Address }[] };
  if (source.fictional !== true || source.humanVerified !== false || source.wallets.length !== 2 || source.wallets[0].label !== 'demo-seeker' || source.wallets[1].label !== 'demo-recruiter') throw new Error('unexpected_demo_wallet_manifest');
  const chainId = await client.getChainId(), block = await client.getBlock();
  if (chainId !== ENS_CHAIN_ID || Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 90) throw new Error('wrong_chain_or_stale_head');
  const parent = await ens.inspectProjectParent({ parentName: 'meeti-demo.eth', issuer });
  if (parent.nextStep !== 'ready') throw new Error('existing_project_parent_not_ready');
  const expiry = Math.floor(Date.parse(parent.expiresAt) / 1000);
  const first = await ens.prepareProjectSubname({ parentName: parent.parentName, label: 'users', issuer, recipient: issuer, expiresAt: expiry });
  const plan = await buildNamespaceDemoPlan({ issuer, parentRegistry: parent.subregistry, parentExpiry: expiry,
    policyExpiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    recipients: source.wallets.map(wallet => {
      const manifest = JSON.parse(readFileSync('artifacts/demo-delegates.json', 'utf8')) as { delegates: { label: string; owner: Address; address: Address }[] };
      const delegate = manifest.delegates.find(value => value.label === wallet.label && value.owner.toLowerCase() === wallet.address.toLowerCase());
      if (!delegate) throw new Error('explicit_independent_delegate_required');
      return { ...wallet, delegate: delegate.address };
    }),
    assertDelegateScope: async delegate => { if (!(await ens.inspectDelegateAncestors({ ensName: parent.parentName, delegate })).allowed) throw new Error('delegate_ancestor_control_too_broad'); },
    predict: async (deployer, salt) => getAddress(await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'predictProxyAddress', args: [deployer, salt], blockNumber: block.number })) });
  if (plan.operations[0].data !== first.data || plan.operations[0].to.toLowerCase() !== first.to.toLowerCase()) throw new Error('live_preparation_differs_from_plan');
  const codeChecks = [];
  for (const [role, address] of Object.entries(ENS_DEPLOYMENT)) {
    const code = await client.getCode({ address, blockNumber: block.number });
    if (!code || code === '0x') throw new Error('documented_contract_code_missing');
    codeChecks.push({ role, address, runtimeCodeHash: keccak256(code) });
  }
  const predicted = [plan.usersRegistry, ...plan.recipients.flatMap(r => [r.recipientRegistry, r.resolver])];
  const predictionChecks = [];
  for (const address of predicted) {
    const code = await client.getCode({ address, blockNumber: block.number });
    predictionChecks.push({ address, codePresent: !!code && code !== '0x' });
    if (code && code !== '0x') throw new Error('predicted_address_already_deployed_reconcile_before_review');
  }
  const registrarRole = await client.readContract({ address: parent.subregistry, abi: registryAbi, functionName: 'hasRoles', args: [0n, 1n, issuer], blockNumber: block.number });
  if (!registrarRole) throw new Error('issuer_registrar_role_missing');
  const fee = await client.estimateFeesPerGas();
  const funding = [], balances = [];
  for (const wallet of [{ label: 'issuer', address: issuer }, ...source.wallets]) {
    const balance = await client.getBalance({ address: wallet.address, blockNumber: block.number });
    balances.push({ label: wallet.label, address: wallet.address, balanceWei: balance.toString() });
    if (wallet.label !== 'issuer' && balance < parseEther('0.003')) funding.push({ id: `fund-${wallet.label}`, from: issuer, to: wallet.address,
      valueWei: (parseEther('0.003') - balance).toString(), chainId: ENS_CHAIN_ID, data: '0x', gasLimit: '21000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '10500000000000', purpose: 'Only Sepolia test ETH for recipient-owned namespace and resolver transactions.' });
  }
  const firstGas = await client.estimateGas({ account: issuer, to: first.to, data: first.data, value: 0n });
  if (firstGas > BigInt(plan.operations[0].gasLimit)) {
    console.log(JSON.stringify({ operation: 'branch-register', estimatedGas: firstGas.toString(), proposedGasLimit: plan.operations[0].gasLimit }));
    throw new Error('first_operation_exceeds_review_gas_limit');
  }
  const fundingValue = funding.reduce((sum, tx) => sum + BigInt(tx.valueWei), 0n), fundingGas = funding.reduce((sum, tx) => sum + BigInt(tx.maxGasCostWei), 0n);
  const issuerTotal = BigInt(plan.gasCaps[issuer]) + fundingValue + fundingGas;
  const report = { reviewOnly: true, approvalState: 'not_authorized_for_signature_or_broadcast', checkedAt: new Date().toISOString(), reviewExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    network: 'Ethereum Sepolia', chainId, blockNumber: block.number.toString(), blockHash: block.hash, parent, codeChecks, predictionChecks, registrarRole,
    fees: { currentSuggestedMaxFeePerGas: fee.maxFeePerGas?.toString(), currentSuggestedMaxPriorityFeePerGas: fee.maxPriorityFeePerGas?.toString(), reviewMaxFeePerGas: '500000000', currentEstimateWithinReview: (fee.maxFeePerGas ?? 0n) <= 500_000_000n, firstOperationEstimatedGas: firstGas.toString() },
    balances, plan, liveSimulatedOperationIds: ['branch-register'], conditionalOperationIds: plan.operations.slice(1).map(op => op.id),
    funding, issuerMaxGasAndTransferValueWei: issuerTotal.toString(), issuerCurrentlyFunded: BigInt(balances[0].balanceWei) >= issuerTotal,
    executionRequirements: ['Explicit bounded approval of these names, recipients, public policies, gas sponsorship and role assignments.', 'Load only the approved issuer or generated test-owner key for its exact sender. Never extract or import MetaMask keys.', 'Before every transaction, reprepare through the live adapter, simulate and match this exact approved destination, calldata, value and sender. Reject changed or expired reviews.', 'Confirm canonical successful receipts and current read-back, including exclusive recipient registry root roles, before dependent operations.', 'No funding transfer above reviewed value, arbitrary transaction, mainnet call, or ERC-8004/public-context write is included.'],
    signaturesRequested: 0, transactionsSubmitted: 0 };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/namespace-demo-review.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ path: 'artifacts/namespace-demo-review.json', checkedAt: report.checkedAt, blockNumber: report.blockNumber, namespaceOperations: plan.operations.length,
    conditionalOperations: report.conditionalOperationIds.length, fundingTransfers: funding.length, issuerMaxGasAndTransferValueWei: issuerTotal.toString(), recipientGasCaps: source.wallets.map(w => ({ address: w.address, maxGasCostWei: plan.gasCaps[getAddress(w.address)] })), issuerCurrentlyFunded: report.issuerCurrentlyFunded, currentFeeWithinReview: report.fees.currentEstimateWithinReview, signatures: 0, broadcasts: 0 }));
} catch (error) {
  // Do not print RPC errors, which may contain authenticated provider URLs.
  console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_review_read_failed_no_signature_or_broadcast');
  process.exitCode = 1;
} finally { ens.disconnect(); }
