import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { buildNamespaceDemoPlan, recipientRegistrySalt } from './namespace-plan';
import { ALL_ROLES, NAME_OWNER_ROLES, POLICY_KEY, STATUS_KEY } from './index';
import { factoryAbi, registryAbi, registryInitAbi, resolverAbi } from './abi';

const issuer = '0x9253705482a44e6A7378163e57cc791AE6213ed5' as Address;
const owners = ['0x4bA49C69BD88972AaCfE4f3B9C15FdF6384fbE0D', '0xe7e8dD285dC3a51cA1a00B49E793E3D5F9228027'] as const;
const input = () => ({ issuer, parentRegistry: issuer, parentExpiry: 1_900_000_000, policyExpiry: '2027-01-01T00:00:00.000Z',
  recipients: owners.map((address, i) => ({ address, label: i ? 'demo-recruiter' : 'demo-seeker', delegate: `0x${(i + 2).toString().repeat(40)}` as Address })),
  assertDelegateScope: async () => {},
  predict: async (_deployer: Address, salt: bigint) => `0x${salt.toString(16).slice(-40).padStart(40, '0')}` as Address });
describe('unsigned conditional namespace review', () => {
  it('produces no fake live success and ties every dependent step to its predecessor', async () => {
    const plan = await buildNamespaceDemoPlan(input());
    expect(plan.operations).toHaveLength(17);
    const seen = new Set<string>();
    for (const op of plan.operations) {
      expect(op.value).toBe('0x0'); expect(op.chainId).toBe(11155111);
      expect(op.simulation).toBe('not_simulated_dependencies_must_confirm');
      expect(op.dependsOn.every(id => seen.has(id))).toBe(true); seen.add(op.id);
      expect(BigInt(op.maxGasCostWei)).toBe(BigInt(op.gasLimit) * BigInt(op.maxFeePerGas));
    }
  });
  it('initializes each recipient registry exclusively to that recipient and registers the owned token with that registry', async () => {
    const plan = await buildNamespaceDemoPlan(input());
    for (const r of plan.recipients) {
      const deploy = decodeFunctionData({ abi: factoryAbi, data: plan.operations.find(op => op.id === `${r.label}-registry`)!.data });
      expect(deploy.functionName).toBe('deployProxy');
      if (deploy.functionName !== 'deployProxy') throw new Error('unexpected_function');
      const init = decodeFunctionData({ abi: registryInitAbi, data: deploy.args[2] });
      expect(init.args?.[0]).toEqual([{ account: r.owner, roleBitmap: ALL_ROLES }]);
      const issue = decodeFunctionData({ abi: registryAbi, data: plan.operations.find(op => op.id === `${r.label}-issue`)!.data });
      expect(issue.functionName).toBe('register');
      expect(issue.args?.slice(0, 5)).toEqual([r.label, r.owner, r.recipientRegistry, '0x0000000000000000000000000000000000000000', NAME_OWNER_ROLES]);
    }
  });
  it('grants only the status setter and keeps policies owner-signed with no private fields', async () => {
    const plan = await buildNamespaceDemoPlan(input());
    for (const r of plan.recipients) {
      const grant = plan.operations.find(op => op.id === `${r.label}-grant`)!;
      expect(grant.from).toBe(r.owner); expect(grant.to).toBe(r.resolver);
      const decoded = decodeFunctionData({ abi: resolverAbi, data: grant.data });
      if (decoded.functionName !== 'grantSetterRoles') throw new Error('wrong_grant');
      const setter = decodeFunctionData({ abi: resolverAbi, data: decoded.args[0] });
      expect(setter.functionName).toBe('setText'); expect(setter.args?.[1]).toBe(STATUS_KEY); expect(decoded.args[1]).toBe(r.delegate);
      const policy = decodeFunctionData({ abi: resolverAbi, data: plan.operations.find(op => op.id === `${r.label}-policy`)!.data });
      expect(policy.args?.[1]).toBe(POLICY_KEY);
      expect(r.proposedPublicPolicy.resolverScope).toBe('dedicated-agent');
    }
  });
  it('rejects the former issuer delegate plan and owner/cross-user keys before predicting or preparing transactions', async () => {
    for (const delegate of [issuer, owners[0], owners[1]]) {
      const proposed = input(); proposed.recipients[0].delegate = delegate;
      let predicted = false;
      await expect(buildNamespaceDemoPlan({ ...proposed, predict: async () => { predicted = true; return issuer; } })).rejects.toThrow('independent_low_privilege_delegate_required');
      expect(predicted).toBe(false);
    }
    await expect(buildNamespaceDemoPlan({ ...input(), assertDelegateScope: async () => { throw new Error('delegate_ancestor_control_too_broad'); } })).rejects.toThrow('delegate_ancestor_control_too_broad');
  });
  it('rejects duplicate owners, ambiguous labels and invalid expiry', async () => {
    const duplicate = input(); duplicate.recipients[1].address = duplicate.recipients[0].address;
    await expect(buildNamespaceDemoPlan(duplicate)).rejects.toThrow('two_distinct_recipients');
    const label = input(); label.recipients[0].label = 'Demo Seeker';
    await expect(buildNamespaceDemoPlan(label)).rejects.toThrow();
    await expect(buildNamespaceDemoPlan({ ...input(), parentExpiry: 1 })).rejects.toThrow('invalid_plan_expiry');
    expect(recipientRegistrySalt('a.users.meeti-demo.eth', owners[0])).not.toBe(recipientRegistrySalt('a.users.meeti-demo.eth', owners[1]));
  });
});
