import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { buildNamespaceDemoPlan } from './namespace-plan';
import { buildNamespaceRepair } from './namespace-repair';
import { encodeInlinePolicyUri, inlinePolicyDigest, STATUS_KEY, TEXT_ROLE, textResource } from './index';
import { resolverAbi } from './abi';
const issuer = '0x1111111111111111111111111111111111111111' as Address;
const owners = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'] as Address[];
const delegates = ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'] as Address[];
async function original() {
  const plan = await buildNamespaceDemoPlan({ issuer, parentRegistry: issuer, parentExpiry: 1900000000, policyExpiry: '2027-01-01T00:00:00.000Z', recipients: owners.map((address, i) => ({ label: i ? 'demo-recruiter' : 'demo-seeker', address, delegate: delegates[i] })), assertDelegateScope: async () => {}, predict: async (_owner, salt) => `0x${salt.toString(16).slice(-40)}` as Address });
  // A historical unsafe review is a fixture input only, never produced by the corrected planner.
  for (const r of plan.recipients) { r.delegate = issuer; r.proposedPublicPolicy.delegate = issuer; }
  return plan;
}
const mapping = () => owners.map((owner, i) => ({ label: i ? 'demo-recruiter' : 'demo-seeker', owner, address: delegates[i] }));
describe('minimal independent-agent remediation', () => {
  it('preserves structural calldata, revokes only old status scope, rotates version and grants only the new delegate', async () => {
    const source = await original(), before = JSON.stringify(source);
    const repair = await buildNamespaceRepair({ original: source, issuer, delegates: mapping(), assertDelegateScope: async () => {} });
    expect(repair.operations).toHaveLength(10); expect(JSON.stringify(source)).toBe(before);
    const revoke = decodeFunctionData({ abi: resolverAbi, data: repair.operations[0].data });
    expect(revoke.functionName).toBe('revokeRoles'); expect(revoke.args).toEqual([textResource(STATUS_KEY), TEXT_ROLE, issuer]);
    for (const suffix of ['registry', 'issue', 'agent', 'resolver', 'attach']) expect(repair.operations.find(op => op.id === `demo-recruiter-${suffix}`)?.data).toBe(source.operations.find(op => op.id === `demo-recruiter-${suffix}`)?.data);
    for (const r of repair.recipients) {
      expect(r.proposedPublicPolicy.version).toBe('2'); expect(r.policyDigest).not.toBe(source.recipients[0].policyDigest);
      const grant = decodeFunctionData({ abi: resolverAbi, data: repair.operations.find(op => op.id === `${r.label}-grant-delegate`)!.data });
      expect(grant.functionName).toBe('grantSetterRoles'); expect(grant.args?.[1]).toBe(r.delegate);
      expect(r.proposedPublicPolicy.uri).toBe(encodeInlinePolicyUri({ ...JSON.parse(Buffer.from(source.recipients[0].proposedPublicPolicy.uri.split(',')[1], 'base64').toString()), version: 2 }));
    }
    expect(inlinePolicyDigest({ version: 2, purpose: 'collaborator', allowedFields: ['displayName', 'headline', 'seeking', 'offering', 'tags'], allowedActions: ['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message'], expiresAt: '2027-01-01T00:00:00.000Z', paused: false })).toBe(repair.recipients[0].policyDigest);
  });
  it('fails closed on issuer, owner, duplicate delegate or reported live ancestor control', async () => {
    const source = await original();
    for (const address of [issuer, owners[0]]) { const bad = mapping(); bad[0].address = address; await expect(buildNamespaceRepair({ original: source, issuer, delegates: bad, assertDelegateScope: async () => {} })).rejects.toThrow('independent_low_privilege_delegate_required'); }
    const duplicate = mapping(); duplicate[1].address = duplicate[0].address;
    await expect(buildNamespaceRepair({ original: source, issuer, delegates: duplicate, assertDelegateScope: async () => {} })).rejects.toThrow('distinct_agent_delegates_required');
    await expect(buildNamespaceRepair({ original: source, issuer, delegates: mapping(), assertDelegateScope: async () => { throw new Error('ancestor_control'); } })).rejects.toThrow('ancestor_control');
  });
});
