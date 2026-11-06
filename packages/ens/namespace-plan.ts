import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, namehash, stringToHex, zeroAddress, type Address, type Hex } from 'viem';
import { ALL_ROLES, NAME_OWNER_ROLES, ENS_CHAIN_ID, ENS_DEPLOYMENT, POLICY_KEY, STATUS_KEY, dedicatedResolverSalt, dnsEncode, encodeInlinePolicyUri, inlinePolicyDigest, normalizeProjectLabel, registrySalt, type EnsInlinePolicy } from './index';
import { factoryAbi, registryAbi, registryInitAbi, resolverAbi } from './abi';

export function recipientRegistrySalt(name: string, recipient: Address): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [keccak256(stringToHex('MeetiRecipientRegistry:v1')), namehash(name), recipient])));
}

export interface NamespacePlanOperation {
  id: string; dependsOn: string[]; operation: string; chainId: number; from: Address; to: Address; data: Hex; value: '0x0';
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; maxGasCostWei: string;
  simulation: 'not_simulated_dependencies_must_confirm';
}

// This constructor produces review material only. An executor must reprepare each operation against current state.
export async function buildNamespaceDemoPlan(input: {
  issuer: Address; parentRegistry: Address; parentExpiry: number; policyExpiry: string;
  recipients: { label: string; address: Address; delegate: Address }[];
  assertDelegateScope: (delegate: Address) => Promise<void>;
  predict: (deployer: Address, salt: bigint) => Promise<Address>;
}) {
  const parent = 'meeti-demo.eth', branch = `users.${parent}`;
  const issuer = getAddress(input.issuer);
  if (input.recipients.length !== 2 || new Set(input.recipients.map(r => r.address.toLowerCase())).size !== 2) throw new Error('two_distinct_recipients_required');
  if (new Set(input.recipients.map(r => r.label)).size !== 2) throw new Error('duplicate_recipient_label');
  if (!Number.isSafeInteger(input.parentExpiry) || !Number.isFinite(Date.parse(input.policyExpiry)) || Date.parse(input.policyExpiry) / 1000 > input.parentExpiry) throw new Error('invalid_plan_expiry');
  for (const recipient of input.recipients) if (normalizeProjectLabel(recipient.label) !== recipient.label) throw new Error('normalized_recipient_label_required');
  if (typeof input.assertDelegateScope !== 'function') throw new Error('delegate_scope_preflight_required');
  for (const recipient of input.recipients) {
    if (!recipient.delegate || [issuer, ...input.recipients.map(r => r.address)].some(address => address.toLowerCase() === recipient.delegate.toLowerCase()) || recipient.delegate === zeroAddress) throw new Error('independent_low_privilege_delegate_required');
    await input.assertDelegateScope(getAddress(recipient.delegate));
  }
  const operations: NamespacePlanOperation[] = [];
  const add = (id: string, dependsOn: string[], operation: string, from: Address, to: Address, data: Hex, gasLimit = 500_000n) => {
    const maxFeePerGas = 500_000_000n;
    operations.push({ id, dependsOn, operation, chainId: ENS_CHAIN_ID, from, to, data, value: '0x0', gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '10000000', maxGasCostWei: (gasLimit * maxFeePerGas).toString(), simulation: 'not_simulated_dependencies_must_confirm' });
  };
  const deployRegistry = (id: string, dependencies: string[], deployer: Address, owner: Address, salt: bigint) => {
    const init = encodeFunctionData({ abi: registryInitAbi, functionName: 'initialize', args: [[{ account: owner, roleBitmap: ALL_ROLES }]] });
    add(id, dependencies, 'deploy-registry', deployer, ENS_DEPLOYMENT.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'deployProxy', args: [ENS_DEPLOYMENT.registryImplementation, salt, init] }), 1_500_000n);
  };
  const usersRegistry = getAddress(await input.predict(issuer, registrySalt(branch)));
  add('branch-register', [], 'issue-users-branch', issuer, input.parentRegistry, encodeFunctionData({ abi: registryAbi, functionName: 'register', args: ['users', issuer, zeroAddress, zeroAddress, NAME_OWNER_ROLES, BigInt(input.parentExpiry)] }), 900_000n);
  deployRegistry('branch-registry', ['branch-register'], issuer, issuer, registrySalt(branch));
  add('branch-attach', ['branch-registry'], 'attach-users-registry', issuer, input.parentRegistry, encodeFunctionData({ abi: registryAbi, functionName: 'setSubregistry', args: [BigInt(keccak256(stringToHex('users'))), usersRegistry] }));
  const recipients = [];
  for (const candidate of input.recipients) {
    const owner = getAddress(candidate.address), delegate = getAddress(candidate.delegate), label = candidate.label, userName = `${label}.${branch}`, agentName = `networking.${userName}`;
    const salt = recipientRegistrySalt(userName, owner), recipientRegistry = getAddress(await input.predict(issuer, salt));
    const resolverSalt = dedicatedResolverSalt(agentName, owner), resolver = getAddress(await input.predict(owner, resolverSalt));
    const policy: EnsInlinePolicy = { version: 1, purpose: 'collaborator', allowedFields: ['displayName', 'headline', 'seeking', 'offering', 'tags'], allowedActions: ['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message'], expiresAt: input.policyExpiry, paused: false };
    const digest = inlinePolicyDigest(policy);
    const publicPolicy = { version: '1', ensName: agentName, owner, delegate, digest, uri: encodeInlinePolicyUri(policy), expiresAt: Math.floor(Date.parse(input.policyExpiry) / 1000), actions: [...policy.allowedActions, 'update-status'], resolverScope: 'dedicated-agent' };
    const tx = (suffix: string) => `${label}-${suffix}`;
    deployRegistry(tx('registry'), ['branch-attach'], issuer, owner, salt);
    add(tx('issue'), [tx('registry')], 'issue-user-name', issuer, usersRegistry, encodeFunctionData({ abi: registryAbi, functionName: 'register', args: [label, owner, recipientRegistry, zeroAddress, NAME_OWNER_ROLES, BigInt(input.parentExpiry)] }), 900_000n);
    add(tx('agent'), [tx('issue')], 'issue-agent-name', owner, recipientRegistry, encodeFunctionData({ abi: registryAbi, functionName: 'register', args: ['networking', owner, zeroAddress, zeroAddress, NAME_OWNER_ROLES, BigInt(input.parentExpiry)] }), 900_000n);
    const init = encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] });
    add(tx('resolver'), [tx('agent')], 'deploy-dedicated-resolver', owner, ENS_DEPLOYMENT.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'deployProxy', args: [ENS_DEPLOYMENT.resolverImplementation, resolverSalt, init] }), 1_500_000n);
    add(tx('attach'), [tx('resolver')], 'attach-dedicated-resolver', owner, recipientRegistry, encodeFunctionData({ abi: registryAbi, functionName: 'setResolver', args: [BigInt(keccak256(stringToHex('networking'))), resolver] }));
    add(tx('policy'), [tx('attach')], 'publish-public-policy', owner, resolver, encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(agentName), POLICY_KEY, JSON.stringify(publicPolicy)] }), 1_500_000n);
    const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(agentName), STATUS_KEY, ''] });
    add(tx('grant'), [tx('policy')], 'grant-status-only', owner, resolver, encodeFunctionData({ abi: resolverAbi, functionName: 'grantSetterRoles', args: [setter, delegate] }));
    recipients.push({ label, owner, userName, agentName, recipientRegistry, resolver, delegate, policyDigest: digest, proposedPublicPolicy: publicPolicy });
  }
  const gasCaps: Record<string, string> = {};
  for (const op of operations) gasCaps[op.from] = (BigInt(gasCaps[op.from] ?? '0') + BigInt(op.maxGasCostWei)).toString();
  return { parent, branch, usersRegistry, recipients, operations, gasCaps, warning: 'Unsigned conditional review only. Parent control, label availability, deployed code, recipient-exclusive roles, policy expiry, simulation, gas and exact calldata must be checked again before every eventual signature. Ancestors retain existing powers. No agent currently exists at these proposed names.' };
}
