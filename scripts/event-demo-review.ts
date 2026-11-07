import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { rabdi } from '@arkiv-network/sdk/chains';
import { createEnsAuthorityProvider, ENS_CHAIN_ID, ENS_DEPLOYMENT } from '../packages/ens';
import { factoryAbi, registryAbi } from '../packages/ens/abi';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';
import { createAgentIdentityProvider, ERC8004_SEPOLIA, identityRegistryAbi } from '../packages/ens/agent-identity';
import { AGENT_CONTEXT_KEY } from '../packages/ens/agent-records';
import { accountReview, EVENT_ORIGIN, EVENT_VAULT_CONTEXT, EVENT_VAULT_PATH, eventLabels, eventVaultSchema, type EventLabel } from './event-demo-accounts';
import { decrypt } from '../packages/server/crypto';

const issuer = getAddress('0x9253705482a44e6A7378163e57cc791AE6213ed5');
const reviewPath = 'artifacts/event-demo-testnet-review.json';
export const eventPublicDraft = (label: EventLabel) => label === 'krishna'
  ? 'Fictional TEST DATA. I offer venue hosting for events and want to collaborate with event organizers. Event location, date, venue capacity and terms are not specified.'
  : 'Fictional TEST DATA. I offer event sponsorship and want to collaborate with event organizers. Sponsorship budget, event scope, dates and terms are not specified.';
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

async function main() {
  requireValue(!existsSync('.local-data/event-demo-testnet-approval.json'), 'approved_event_review_is_immutable');
  const walletVault = eventVaultSchema.parse(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT));
  requireValue(walletVault.wallets.every(item => item.accountId && item.profileConfirmedAt), 'review_requires_created_event_accounts');
  const manifest = accountReview(walletVault), rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  requireValue(rpcUrl && process.env.ARKIV_ACCESS_KEY, 'configured_read_rpc_and_arkiv_key_required');
  requireValue(process.env.ENS_PROJECT_PARENT === undefined || process.env.ENS_PROJECT_PARENT === 'meeti-demo.eth', 'review_parent_must_be_meeti_demo');
  requireValue(!process.env.ENS_PROJECT_ISSUER || process.env.ENS_PROJECT_ISSUER.toLowerCase() === issuer.toLowerCase(), 'review_issuer_configuration_mismatch');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) }), ens = createEnsAuthorityProvider({ rpcUrl });
  try {
    const [chain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    requireValue(chain === ENS_CHAIN_ID && Math.abs(Date.now() / 1000 - Number(block.timestamp)) < 90, 'review_wrong_chain_or_stale_head');
    const parent = await ens.inspectProjectParent({ parentName: 'meeti-demo.eth', issuer }), branch = await ens.inspectProjectParent({ parentName: 'users.meeti-demo.eth', issuer });
    requireValue(parent.nextStep === 'ready' && branch.nextStep === 'ready', 'existing_users_branch_not_ready');
    const expiry = Math.floor(Math.min(Date.parse(parent.expiresAt), Date.parse(branch.expiresAt)) / 1000);
    const policyExpiresAt = new Date(Math.min(expiry * 1000, Date.now() + 7 * 86400000)).toISOString();
    const recipients = manifest.accounts.map(account => ({ label: account.proposedLabel, address: getAddress(account.owner), delegate: getAddress(account.delegate) }));
    const plan = await buildNamespaceDemoPlan({ issuer, parentRegistry: parent.subregistry, parentExpiry: expiry, policyExpiry: policyExpiresAt, recipients,
      assertDelegateScope: async delegate => {
        requireValue((await ens.inspectDelegateAncestors({ ensName: branch.parentName, delegate })).allowed, 'event_delegate_ancestor_control');
        requireValue(await client.readContract({ address: branch.subregistry, abi: registryAbi, functionName: 'roles', args: [0n, delegate], blockNumber: block.number }) === 0n, 'event_delegate_branch_root_control');
      },
      predict: async (deployer, salt) => getAddress(await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'predictProxyAddress', args: [deployer, salt], blockNumber: block.number })),
    });
    requireValue(plan.usersRegistry.toLowerCase() === branch.subregistry.toLowerCase(), 'existing_branch_differs_from_reused_namespace_plan');
    const namespaceOperations = plan.operations.filter(operation => !operation.id.startsWith('branch-')).map(operation => ({ ...operation, dependsOn: operation.dependsOn.filter(id => !id.startsWith('branch-')) }));
    const checks = [];
    for (const recipient of plan.recipients) {
      const prepared = await ens.prepareProjectRecipientRegistry({ parentName: branch.parentName, label: recipient.label, issuer, recipient: recipient.owner });
      requireValue(prepared.needed, 'event_recipient_registry_requires_reconciliation');
      const operation = namespaceOperations.find(operation => operation.id === `${recipient.label}-registry`)!;
      requireValue(prepared.from === operation.from && prepared.to.toLowerCase() === operation.to.toLowerCase() && prepared.data === operation.data, 'event_live_registry_preparation_mismatch');
      const estimatedGas = await client.estimateGas({ account: issuer, to: operation.to, data: operation.data, value: 0n });
      requireValue(estimatedGas <= BigInt(operation.gasLimit), 'event_registry_gas_exceeds_review_cap');
      const resolverCode = await client.getCode({ address: recipient.resolver }); requireValue(!resolverCode || resolverCode === '0x', 'event_resolver_already_exists');
      checks.push({ label: recipient.label, labelUnusedAndIssuerControlled: true, liveSimulatedOperation: operation.id, estimatedGas: estimatedGas.toString(), recipientRegistry: recipient.recipientRegistry, resolver: recipient.resolver });
    }
    const identity = createAgentIdentityProvider({ ens, rpcUrl }), deployment = await identity.inspectDeployment();
    requireValue(deployment.verified, 'event_erc8004_deployment_not_verified');
    const codeChecks = [];
    for (const [role, address] of Object.entries({ ...ENS_DEPLOYMENT, identityRegistry: ERC8004_SEPOLIA.registry })) {
      const code = await client.getCode({ address }); requireValue(code && code !== '0x', 'event_required_contract_code_missing');
      codeChecks.push({ role, address, runtimeCodeHash: keccak256(code) });
    }
    const identityOperations = plan.recipients.flatMap((recipient, index) => {
      const label = eventLabels[index], name = manifest.accounts[index].profile.displayName;
      const context = { type: 'meeti-agent-context-v1', ensName: recipient.agentName, name: `${name} networking representative (fictional test)`, description: eventPublicDraft(label), capabilities: recipient.proposedPublicPolicy.actions.filter(action => action !== 'update-status'), endpoints: [] };
      return [
        { id: `${recipient.label}-identity-register`, operation: 'register-identity', to: ERC8004_SEPOLIA.registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register' }), conditional: 'After namespace, resolver, policy and import are confirmed.' },
        { id: `${recipient.label}-identity-context`, operation: 'publish-context', to: recipient.resolver, data: null, conditional: 'Bind only the canonical confirmed registration receipt identity to this exact public context.', publicContextTemplate: context, recordKey: AGENT_CONTEXT_KEY },
        { id: `${recipient.label}-identity-uri`, operation: 'set-identity-uri', to: ERC8004_SEPOLIA.registry, data: null, conditional: 'Use the receipt-derived agentId and current registration-v1 document claiming this ENS name. No invented ID.' },
        { id: `${recipient.label}-identity-attest`, operation: 'attest-association', to: recipient.resolver, data: null, conditional: 'Use exact current ENSIP-25 ERC-7930 registry key and nonempty attestation only after live registration agreement.', recordValue: '1' },
      ].map(operation => ({ ...operation, chainId: 11155111, from: recipient.owner, valueWei: '0', maxGasCostWei: '500000000000000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000' }));
    });
    const balances = [];
    for (const address of [issuer, ...recipients.map(recipient => recipient.address)]) balances.push({ address, balanceWei: (await client.getBalance({ address })).toString() });
    const namespaceCaps: Record<string, bigint> = {};
    for (const operation of namespaceOperations) namespaceCaps[operation.from] = (namespaceCaps[operation.from] || 0n) + BigInt(operation.maxGasCostWei);
    const funding = recipients.map(recipient => ({ chainId: 11155111, from: issuer, to: recipient.address, valueWei: parseEther('0.006').toString(), data: '0x', gasLimit: '21000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '10500000000000' }));
    const issuerCap = (namespaceCaps[issuer] || 0n) + funding.reduce((sum, transaction) => sum + BigInt(transaction.valueWei) + BigInt(transaction.maxGasCostWei), 0n);
    const arkiv = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY }), transport: http(undefined, { retryCount: 0, timeout: 12000, fetchOptions: { redirect: 'error', cache: 'no-store' } }) });
    const [arkivChain, arkivHead, genesis] = await Promise.all([arkiv.getChainId(), arkiv.getBlock(), arkiv.getBlock({ blockNumber: 0n })]);
    requireValue(arkivChain === 7794095 && Math.abs(Date.now() / 1000 - Number(arkivHead.timestamp)) < 90, 'event_rabdi_wrong_chain_or_stale_head');
    const arkivBalances = [];
    for (const address of [issuer, ...recipients.map(recipient => recipient.address)]) arkivBalances.push({ address, balanceWei: (await arkiv.getBalance({ address })).toString() });
    const arkivFunding = [];
    for (const recipient of recipients) {
      const estimate = await arkiv.estimateGas({ account: issuer, to: recipient.address, value: parseEther('0.02'), data: '0x' });
      const gas = estimate * 2n > 1000000n ? estimate * 2n : 1000000n;
      requireValue(gas <= arkivHead.gasLimit / 2n, 'event_rabdi_funding_gas_exceeds_half_block');
      arkivFunding.push({ id: `fund-rabdi-${recipient.label}`, chainId: 7794095, from: issuer, to: recipient.address, valueWei: parseEther('0.02').toString(), data: '0x', gasLimit: gas.toString(), maximumGasPriceWei: (5000000000000000n / gas).toString(), maxGasCostWei: '5000000000000000' });
    }
    const createdAt = new Date().toISOString();
    const report = { version: 1, reviewOnly: true, approvalState: 'NOT_APPROVED_NO_SIGNATURE_OR_BROADCAST', fictional: true, humanVerified: false, origin: EVENT_ORIGIN, createdAt, reviewExpiresAt: new Date(Date.now() + 6 * 3600000).toISOString(),
      presenterApprovedIntent: 'I am organizing an event and want to collaborate with venue hosts and sponsors.',
      accounts: manifest.accounts.map((account, index) => ({ label: account.label, accountId: walletVault.wallets.find(wallet => wallet.label === account.label)!.accountId, owner: account.owner, delegate: account.delegate, userName: plan.recipients[index].userName, agentName: plan.recipients[index].agentName })),
      ens: { network: 'Sepolia ENSv2 test deployment', chainId: chain, blockNumber: block.number.toString(), parent, branch, reuseExistingBranch: true, codeChecks, checks, recipients: plan.recipients, policyExpiresAt, namespaceOperations, identityDeployment: deployment, identityOperations,
        funding, balances, issuerMaxGasAndTransferWei: issuerCap.toString(), issuerCurrentlyFunded: BigInt(balances[0].balanceWei) >= issuerCap,
        ownerCaps: recipients.map(recipient => ({ owner: recipient.address, namespaceGasWei: namespaceCaps[recipient.address].toString(), identityGasWei: '2000000000000000', totalMaxGasWei: (namespaceCaps[recipient.address] + 2000000000000000n).toString() })),
        custody: 'Each generated owner controls its user token, recipient registry and dedicated resolver. Its separate generated delegate receives only the public status-record setter permission. The project issuer retains existing ancestor registry powers. No user private key is sent to the application.' },
      arkiv: { network: 'Rabdi', chainId: arkivChain, genesisHash: genesis.hash, observedBlock: arkivHead.number.toString(), balances: arkivBalances, funding: arkivFunding,
        issuerMaximumFundsAndGasWei: '50000000000000000', fundingWeiPerOwner: '20000000000000000', maximumPublicationFeePerOwnerWei: '10000000000000000',
        status: 'FINAL_PUBLIC_PAYLOAD_REVIEW_BLOCKED_UNTIL_NAMES_AND_REAL_BACKEND_DRAFTS_EXIST', proposedRecords: eventLabels.map((label, index) => ({ label, owner: recipients[index].address, ensAgentRef: plan.recipients[index].agentName, goal: 'collaborator', proposedDirection: 'collaborating', approvedTextCandidate: eventPublicDraft(label), expiry: 'Exactly 24 hours from actual approved draft creation, not from this conditional review.' })),
        requirements: ['Obtain actual runtime structured interpretation and owner review without inventing terms.', 'Create real owner-bound backend drafts after genuine ENS import.', 'Read exact publish previews including real intentId, revision, schema and expiry into a separate final Arkiv approval review.', 'Do not sign a public intent message or chain transaction from this conditional text plan.'] },
      unknowns: ['Actual venue, capacity, location, dates, availability, fees and event scope.', 'Actual sponsorship organization, budget, obligations or committed funds.', 'Presenter account and ENS identity are not selected by this script.', 'Linux hosted semantic provider repair and the remaining durable model quota need independent verification.'],
      signatures: 0, broadcasts: 0, modelCalls: 0 };
    mkdirSync('artifacts', { recursive: true }); const raw = JSON.stringify(report, null, 2); writeFileSync(reviewPath, raw);
    console.log(JSON.stringify({ path: reviewPath, reviewSha256: createHash('sha256').update(raw).digest('hex'), namespaceOperations: namespaceOperations.length, conditionalIdentityOperations: identityOperations.length,
      sepoliaIssuerMaxGasAndTransferWei: issuerCap.toString(), sepoliaIssuerCurrentlyFunded: report.ens.issuerCurrentlyFunded, ownerGasCaps: report.ens.ownerCaps, arkivIssuerBalanceWei: arkivBalances[0].balanceWei, arkivCapWei: report.arkiv.issuerMaximumFundsAndGasWei, finalArkivReviewReady: false, signatures: 0, broadcasts: 0, modelCalls: 0 }));
  } finally { ens.disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'event_testnet_read_review_failed_no_private_diagnostics'); process.exitCode = 1; });
