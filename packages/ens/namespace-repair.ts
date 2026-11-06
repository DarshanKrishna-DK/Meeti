import { encodeFunctionData, getAddress, type Address } from 'viem';
import { decodeInlinePolicyUri, dnsEncode, encodeInlinePolicyUri, inlinePolicyDigest, POLICY_KEY, STATUS_KEY, TEXT_ROLE, textResource } from './index';
import { resolverAbi } from './abi';
import type { buildNamespaceDemoPlan, NamespacePlanOperation } from './namespace-plan';

type OriginalPlan = Awaited<ReturnType<typeof buildNamespaceDemoPlan>>;
export type RepairOperation = NamespacePlanOperation & { kind: string; recipientLabel: string; adapterOperation?: 'revoke' | 'set-policy' | 'grant'; valueWei: '0' };
export async function buildNamespaceRepair(input: { original: OriginalPlan; issuer: Address; delegates: { label: string; owner: Address; address: Address }[]; assertDelegateScope: (input: { delegate: Address; ensName: string }) => Promise<void> }) {
  const issuer = getAddress(input.issuer), recipients = [], operations: RepairOperation[] = [];
  if (input.original.parent !== 'meeti-demo.eth' || input.original.branch !== 'users.meeti-demo.eth' || input.original.recipients.length !== 2 || input.delegates.length !== 2 || typeof input.assertDelegateScope !== 'function') throw new Error('unexpected_repair_scope');
  if (new Set(input.delegates.map(value => value.address.toLowerCase())).size !== 2) throw new Error('distinct_agent_delegates_required');
  const namespaceOwners = input.original.recipients.map(value => value.owner);
  for (const r of input.original.recipients) {
    const record = input.delegates.find(value => value.label === r.label && value.owner.toLowerCase() === r.owner.toLowerCase());
    if (!record) throw new Error('matching_owner_delegate_required');
    const delegate = getAddress(record.address);
    if ([issuer, ...namespaceOwners, '0x0000000000000000000000000000000000000000'].some(address => address.toLowerCase() === delegate.toLowerCase())) throw new Error('independent_low_privilege_delegate_required');
    await input.assertDelegateScope({ delegate, ensName: r.label === 'demo-seeker' ? r.agentName : input.original.branch });
    const oldInline = decodeInlinePolicyUri(r.proposedPublicPolicy.uri);
    if (oldInline.version !== 1 || r.proposedPublicPolicy.version !== '1' || r.delegate.toLowerCase() !== issuer.toLowerCase()) throw new Error('original_policy_rotation_scope_mismatch');
    const inline = { ...oldInline, version: 2 }, policyDigest = inlinePolicyDigest(inline);
    const publicPolicy = { ...r.proposedPublicPolicy, version: '2', delegate, digest: policyDigest, uri: encodeInlinePolicyUri(inline) };
    const recipient = { ...r, oldDelegate: issuer, newDelegate: delegate, delegate, policyVersion: 2, policyDigest, proposedPublicPolicy: publicPolicy };
    recipients.push(recipient);
    const add = (id: string, dependsOn: string[], adapterOperation: 'revoke' | 'set-policy' | 'grant', data: `0x${string}`) => operations.push({ id, dependsOn, adapterOperation, kind: adapterOperation, recipientLabel: r.label, operation: adapterOperation,
      chainId: 11155111, from: r.owner, to: r.resolver, data, value: '0x0', valueWei: '0', gasLimit: '1500000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '750000000000000', simulation: 'not_simulated_dependencies_must_confirm' });
    if (r.label === 'demo-seeker') {
      add('demo-seeker-revoke-issuer', [], 'revoke', encodeFunctionData({ abi: resolverAbi, functionName: 'revokeRoles', args: [textResource(STATUS_KEY), TEXT_ROLE, issuer] }));
    } else if (r.label === 'demo-recruiter') {
      for (const suffix of ['registry', 'issue', 'agent', 'resolver', 'attach']) {
        const original = input.original.operations.find(op => op.id === `${r.label}-${suffix}`);
        if (!original) throw new Error('original_structural_operation_missing');
        operations.push({ ...original, kind: original.operation, recipientLabel: r.label, valueWei: '0' });
      }
    } else throw new Error('unexpected_fictional_recipient');
    const dependency = r.label === 'demo-seeker' ? 'demo-seeker-revoke-issuer' : 'demo-recruiter-attach';
    add(`${r.label}-policy-v2`, [dependency], 'set-policy', encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(r.agentName), POLICY_KEY, JSON.stringify(publicPolicy)] }));
    const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(r.agentName), STATUS_KEY, ''] });
    add(`${r.label}-grant-delegate`, [`${r.label}-policy-v2`], 'grant', encodeFunctionData({ abi: resolverAbi, functionName: 'grantSetterRoles', args: [setter, delegate] }));
  }
  const gasCaps: Record<string, string> = {};
  for (const op of operations) gasCaps[op.from] = (BigInt(gasCaps[op.from] ?? '0') + BigInt(op.maxGasCostWei)).toString();
  return { recipients, operations, gasCaps };
}
