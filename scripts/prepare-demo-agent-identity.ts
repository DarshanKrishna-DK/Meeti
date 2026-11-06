import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, decodeInlinePolicyUri, dnsEncode, ENS_DEPLOYMENT } from '../packages/ens';
import { resolverAbi } from '../packages/ens/abi';
import { createAgentIdentityProvider, ERC8004_SEPOLIA, identityRegistryAbi, type PreparedIdentityTransaction } from '../packages/ens/agent-identity';
import { AGENT_CONTEXT_KEY, agentEndpointKey, agentRegistrationKey, encodeEvmInteroperableAddress, erc8004RegistrationSchema, publicAgentContextSchema, registrationDataUri, registryReference, validateRegistrationAgreement, type PublicAgentContext } from '../packages/ens/agent-records';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import type { buildNamespaceRepair } from '../packages/ens/namespace-repair';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const receiptIdPlaceholder = '$REGISTERED_AGENT_ID';
export type DemoIdentityOwnerReview = {
  label: 'demo-seeker' | 'demo-recruiter'; owner: Address; delegate: Address; ensName: string; resolver: Address;
  publicContext: PublicAgentContext; registrationPrepared: PreparedIdentityTransaction;
  maxGasCostWeiPerOperation: '500000000000000'; totalMaxGasCostWei: '2000000000000000';
};
export type DemoIdentityStep = 'publish-context' | 'set-identity-uri' | 'attest-association';

function reviewedContext(review: DemoIdentityOwnerReview): PublicAgentContext {
  const context = publicAgentContextSchema.parse(review.publicContext);
  requireValue(['demo-seeker', 'demo-recruiter'].includes(review.label) && context.ensName === review.ensName && context.endpoints.length === 0 && context.registration === undefined, 'identity_review_public_context_scope_mismatch');
  requireValue(review.maxGasCostWeiPerOperation === '500000000000000' && review.totalMaxGasCostWei === '2000000000000000', 'identity_review_budget_mismatch');
  const prepared = review.registrationPrepared;
  requireValue(prepared.operation === 'register-identity' && prepared.chainId === 11155111 && same(prepared.from, review.owner) && same(prepared.to, ERC8004_SEPOLIA.registry) && prepared.value === '0x0' && prepared.ensName === review.ensName && prepared.data === encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register' }), 'identity_review_registration_scope_mismatch');
  return context;
}

/** Read-only preparation. No caller-supplied agent ID is accepted. The executor must supply its exact signed registration journal hash. */
export async function prepareConditionalDemoAgentIdentityStep(input: {
  review: DemoIdentityOwnerReview; registrationHash: Hex; operation: DemoIdentityStep;
  ens: ReturnType<typeof createEnsAuthorityProvider>; identity: ReturnType<typeof createAgentIdentityProvider>;
}) {
  const fixed = reviewedContext(input.review);
  const confirmed = await input.identity.confirmTransaction({ hash: input.registrationHash, prepared: input.review.registrationPrepared });
  const identity = confirmed.identity;
  requireValue(confirmed.confirmed && identity && identity.chainId === 11155111 && same(identity.registry, ERC8004_SEPOLIA.registry) && /^(0|[1-9][0-9]*)$/.test(identity.agentId), 'canonical_registered_event_identity_required');
  const context = publicAgentContextSchema.parse({ ...fixed, registration: identity });
  const document = validateRegistrationAgreement(erc8004RegistrationSchema.parse({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: fixed.name, description: fixed.description,
    services: [{ name: 'ENS', endpoint: input.review.ensName, version: 'v2' }], x402Support: false, active: true,
    registrations: [{ agentId: identity.agentId, agentRegistry: registryReference(identity) }], supportedTrust: [],
  }), identity, input.review.ensName);
  let transaction;
  if (input.operation === 'publish-context') transaction = await input.ens.preparePublicAgentRecord({ ensName: input.review.ensName, owner: input.review.owner, key: AGENT_CONTEXT_KEY, value: JSON.stringify(context) });
  else {
    const current = await input.ens.readPublicAgentRecords({ ensName: input.review.ensName, owner: input.review.owner, keys: [AGENT_CONTEXT_KEY] });
    requireValue(current.records[AGENT_CONTEXT_KEY] === JSON.stringify(context) && same(current.resolver, input.review.resolver), 'reviewed_receipt_bound_context_not_confirmed');
    if (input.operation === 'set-identity-uri') transaction = await input.identity.prepareTransaction({ operation: 'set-identity-uri', ensName: input.review.ensName, owner: input.review.owner, identity, document });
    else {
      requireValue(input.operation === 'attest-association', 'unknown_identity_review_step');
      // This additionally reads ownerOf, tokenURI, the exact registration claim and current ENS before preparing the attestation.
      const association = await input.identity.prepareAssociationRecord({ identity, ensName: input.review.ensName, owner: input.review.owner });
      requireValue(association.key === agentRegistrationKey(identity) && association.value === '1', 'receipt_bound_attestation_mismatch');
      transaction = await input.ens.preparePublicAgentRecord(association);
    }
  }
  const expectedTo = input.operation === 'set-identity-uri' ? ERC8004_SEPOLIA.registry : input.review.resolver;
  const expectedData = input.operation === 'set-identity-uri'
    ? encodeFunctionData({ abi: identityRegistryAbi, functionName: 'setAgentURI', args: [BigInt(identity.agentId), registrationDataUri(document)] })
    : encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(input.review.ensName), input.operation === 'publish-context' ? AGENT_CONTEXT_KEY : agentRegistrationKey(identity), input.operation === 'publish-context' ? JSON.stringify(context) : '1'] });
  requireValue(transaction.chainId === 11155111 && same(transaction.from, input.review.owner) && same(transaction.to, expectedTo) && transaction.value === '0x0' && transaction.ensName === input.review.ensName && transaction.data === expectedData, 'conditional_identity_transaction_scope_mismatch');
  return { transaction, identity, context, document, registrationTransactionHash: input.registrationHash,
    registrationBlockNumber: confirmed.blockNumber, maxGasCostWei: input.review.maxGasCostWeiPerOperation, authorityVerified: false, humanVerified: false };
}

async function main() {
  requireValue(!existsSync('.local-data/demo-agent-identity-approval.json'), 'approved_agent_identity_review_is_immutable');
  const repairRaw = readFileSync('artifacts/namespace-repair-review.json', 'utf8'), repairReviewSha256 = sha(repairRaw);
  const repaired = JSON.parse(repairRaw) as Awaited<ReturnType<typeof buildNamespaceRepair>> & { funding: { id: string }[] };
  const execution = JSON.parse(readFileSync('artifacts/namespace-repair-execution.json', 'utf8')) as { reviewSha256: string; transactions: { id: string; hash: Hex; status: string }[] };
  const expectedIds = [...repaired.funding, ...repaired.operations].map(op => op.id);
  requireValue(execution.reviewSha256 === repairReviewSha256 && execution.transactions.length === expectedIds.length && execution.transactions.every((entry, i) => entry.id === expectedIds[i] && entry.status === 'confirmed_readback'), 'confirmed_repaired_namespaces_required');
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  requireValue(rpcUrl, 'ens_rpc_not_configured');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) }), ens = createEnsAuthorityProvider({ rpcUrl }), identityProvider = createAgentIdentityProvider({ ens, rpcUrl });
  try {
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    requireValue(chainId === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_or_stale_identity_review_head');
    const deployment = await identityProvider.inspectDeployment(); requireValue(deployment.verified, 'pinned_erc8004_deployment_not_verified');
    const codeChecks = [];
    for (const [role, address] of Object.entries({ identityRegistry: ERC8004_SEPOLIA.registry, identityImplementation: ERC8004_SEPOLIA.implementation, ensFactory: ENS_DEPLOYMENT.factory, ensRegistryImplementation: ENS_DEPLOYMENT.registryImplementation, ensResolverImplementation: ENS_DEPLOYMENT.resolverImplementation })) {
      const code = await client.getCode({ address }); requireValue(code && code !== '0x', 'identity_review_contract_code_missing');
      codeChecks.push({ role, address, runtimeCodeHash: keccak256(code) });
    }
    const owners: DemoIdentityOwnerReview[] = [], operations = [], checks = [], templates = [], totalCaps: Record<string, string> = {};
    for (const r of repaired.recipients) {
      requireValue(r.label === 'demo-seeker' || r.label === 'demo-recruiter', 'unexpected_identity_test_owner');
      const authority = await ens.checkAuthority({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, action: 'discover', policyVersion: '2', policyDigest: r.policyDigest });
      requireValue(authority.allowed && authority.publicPolicy, 'current_v2_permission_required');
      const policy = decodeInlinePolicyUri(authority.publicPolicy.uri);
      const resolved = await ens.readPublicAgentRecords({ ensName: r.agentName, owner: r.owner, keys: [AGENT_CONTEXT_KEY, agentEndpointKey('meeti-rest-v1'), agentEndpointKey('web')] });
      requireValue(same(resolved.owner, r.owner) && same(resolved.resolver, r.resolver), 'identity_name_or_resolver_changed');
      requireValue(Object.values(resolved.records).every(value => !value), 'existing_public_discovery_records_require_review');
      const existingRegistrations = await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']), functionName: 'balanceOf', args: [getAddress(r.owner)] });
      requireValue(existingRegistrations === 0n, 'existing_identity_registration_requires_recovery');
      const publicContext = publicAgentContextSchema.parse({ type: 'meeti-agent-context-v1', ensName: r.agentName, name: `Meeti ${r.label} test agent`,
        description: 'Fictional Meeti networking test agent for authorized collaborator discovery and qualification. World verification is paused. No human verification or professional credentials are claimed, and final introduction release remains gated.',
        capabilities: policy.allowedActions, endpoints: [] });
      const registrationPrepared = await identityProvider.prepareTransaction({ operation: 'register-identity', ensName: r.agentName, owner: r.owner });
      const reviewed: DemoIdentityOwnerReview = { label: r.label, owner: getAddress(r.owner), delegate: getAddress(r.delegate), ensName: r.agentName, resolver: getAddress(r.resolver), publicContext, registrationPrepared, maxGasCostWeiPerOperation: '500000000000000', totalMaxGasCostWei: '2000000000000000' };
      reviewedContext(reviewed); owners.push(reviewed); totalCaps[reviewed.owner] = reviewed.totalMaxGasCostWei;
      const estimate = await client.estimateGas({ account: reviewed.owner, to: registrationPrepared.to, data: registrationPrepared.data, value: 0n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 10000000n });
      const feeHead = await client.getBlock(), balance = await client.getBalance({ address: reviewed.owner });
      const envelope = boundedFundingEnvelope({ estimatedGas: estimate, maxGasCostWei: 500000000000000n, reviewedMaxFeePerGas: 500000000n, reviewedMaxPriorityFeePerGas: 10000000n, baseFeePerGas: feeHead.baseFeePerGas ?? 0n });
      requireValue(balance >= envelope.maxGasCostWei, 'first_identity_operation_test_eth_unavailable_no_funding_assumed');
      const resolverCode = await client.getCode({ address: reviewed.resolver }); requireValue(resolverCode && resolverCode !== '0x', 'current_dedicated_resolver_code_missing');
      checks.push({ owner: reviewed.owner, ensName: reviewed.ensName, resolver: reviewed.resolver, resolverCodeHash: keccak256(resolverCode), existingRegistryNftBalance: existingRegistrations.toString(), currentAuthority: { allowed: true, policyVersion: 2, policyDigest: r.policyDigest, blockNumber: authority.blockNumber }, balanceWei: balance.toString(), firstOperationEstimatedGas: estimate.toString(), firstEnvelope: Object.fromEntries(Object.entries(envelope).map(([key, value]) => [key, value.toString()])), maximumBatchCurrentlyFunded: balance >= 2000000000000000n });
      const tupleTemplate = { chainId: 11155111, registry: ERC8004_SEPOLIA.registry, agentId: receiptIdPlaceholder };
      const contextTemplate = { ...publicContext, registration: tupleTemplate };
      const registrationTemplate = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: publicContext.name, description: publicContext.description, services: [{ name: 'ENS', endpoint: reviewed.ensName, version: 'v2' }], x402Support: false, active: true, registrations: [{ agentId: receiptIdPlaceholder, agentRegistry: registryReference(ERC8004_SEPOLIA) }], supportedTrust: [] };
      const interoperableRegistry = encodeEvmInteroperableAddress(11155111, ERC8004_SEPOLIA.registry);
      templates.push({ label: r.label, placeholderIsNotAnAgentId: true, contextTemplate, registrationDocumentTemplate: registrationTemplate, attestationTemplate: { key: `agent-registration[${interoperableRegistry}][${receiptIdPlaceholder}]`, value: '1' } });
      const steps = ['register-identity', 'publish-context', 'set-identity-uri', 'attest-association'] as const;
      for (const [index, operation] of steps.entries()) operations.push({ id: `${r.label}-${operation}`, label: r.label, operation, chainId: 11155111, from: reviewed.owner,
        to: operation === 'register-identity' || operation === 'set-identity-uri' ? ERC8004_SEPOLIA.registry : reviewed.resolver,
        valueWei: '0', maxGasCostWei: '500000000000000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000',
        dependsOn: index ? [`${r.label}-${steps[index - 1]}`] : [], data: operation === 'register-identity' ? registrationPrepared.data : null,
        simulation: operation === 'register-identity' ? 'actual_current_state_simulation_passed' : 'not_simulated_requires_canonical_registration_receipt_and_confirmed_dependencies',
        materialization: operation === 'register-identity' ? 'exact_reviewed_register_no_argument_calldata' : 'prepareConditionalDemoAgentIdentityStep_with_only_this_reviewed_owner_and_immutable_registration_journal_hash' });
    }
    const finalHead = await client.getBlock(); requireValue(Math.abs(Date.now() / 1000 - Number(finalHead.timestamp)) < 90, 'identity_review_head_stale');
    const report = { version: 1, reviewOnly: true, approvalState: 'not_authorized_for_signature_or_broadcast', fictional: true, humanVerified: false, chainId: 11155111, checkedAt: new Date().toISOString(), reviewExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), repairReviewSha256, deployment, pinnedDeployment: ERC8004_SEPOLIA, codeChecks, owners, templates, operations, funding: [], totalCaps, checks,
      observedBlockNumber: finalHead.number.toString(), observedBlockHash: finalHead.hash,
      conditionalBinding: { source: 'The actual Registered event from the exact reviewed owner-to-registry register() transaction in the immutable executor journal.', registry: ERC8004_SEPOLIA.registry, chainId: 11155111, minimumCanonicalDepth: 2, exactlyOneMatchingRegisteredEvent: true, requireEmptyInitialAgentURI: true, requireCurrentOwnerOf: true, callerSuppliedAgentIdAllowed: false, unknownIdsAreNotPredictions: true,
        replaceOnly: ['context.registration.agentId', 'registration.registrations[0].agentId', 'setAgentURI agentId argument', 'ENSIP25 attestation key agentId parameter'], encodings: ['Strict approved Meeti JSON context with endpoints:[] and confirmed tuple.', 'Strict ERC8004 registration-v1 JSON, ENS-only services, exact chain+registry+ID, x402Support:false, supportedTrust:[].', 'UTF-8 JSON encoded as data:application/json;base64, bounded by the existing 8192-byte registration adapter.', 'ENSIP25 ERC-7930 registry encoding: version0001 + EIP155 namespace0000 + minimal big-endian chain reference + address length14 + 20-byte registry. Nonempty attestation value is exactly 1.'] },
      custody: 'Each fictional owner controls its ENS names/resolver and registry NFT. Independent agent signing keys remain separate. The platform retains disclosed ancestor powers. No MetaMask key, private profile, file, contact or conversation is used in these public records.',
      requirements: ['A separate bounded approval must cover these exact public fields, fixed algorithms and per-operation/owner fee caps before any signature.', 'Never guess, read a global next-ID counter, substitute another registration or accept a caller-provided agentId. Bind only the confirmed reviewed registration journal hash.', 'After every step, verify exact canonical successful receipt and current owner/record/registration state before preparing the next step.', 'Before every signature, reprepare exact data with the existing providers, estimate fresh gas and lower fee-per-gas as needed to remain within the original .0005-test-ETH operation cap and .002-test-ETH owner aggregate.', 'Context/metadata contain no external endpoint. No A2A, MCP, public hosting, credential verification, trust score or World identity is advertised.', 'The final attestation must be read back and independently verified through registry-to-ENS agreement. Registration alone is not an ENS association or application permission.'],
      officialSources: ['https://docs.ens.domains/ensip/26/', 'https://docs.ens.domains/ensip/25/', 'https://eips.ethereum.org/EIPS/eip-8004'], standardsStatus: 'ENSIP25, ENSIP26 and ERC8004 are draft assumptions pinned to the current adapter and deployment source revision.', signaturesRequested: 0, transactionsSubmitted: 0 };
    const output = JSON.stringify(report, null, 2), path = 'artifacts/demo-agent-identity-review.json'; mkdirSync('artifacts', { recursive: true }); writeFileSync(path, output);
    console.log(JSON.stringify({ path, reviewSha256: sha(output), checkedAt: report.checkedAt, reviewExpiresAt: report.reviewExpiresAt, operations: operations.length, totalCaps, confirmedAgentIdsKnown: false, registrationFirstStepSimulations: owners.length, laterOperationsSimulated: false, noFunding: true, signatures: 0, broadcasts: 0 }));
  } finally { await Promise.all([ens.disconnect(), identityProvider.disconnect()]); const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> }; try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* No authenticated endpoint details in cleanup output. */ } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'agent_identity_review_read_failed_no_secret_details_logged'); process.exitCode = 1; });
