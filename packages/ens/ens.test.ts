import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, keccak256, stringToHex, type Address, type PublicClient } from "viem";
import { createEnsAuthorityProvider, encodeInlinePolicyUri, ENS_DEPLOYMENT, evaluatePublicPolicy, inlinePolicyDigest, normalizeProjectLabel, POLICY_KEY, publicPolicySchema, STATUS_KEY, textResource, validateAgentName, verifyEnsIndependently, type EnsPublicPolicy } from "./index";
import { registryAbi, registryInitAbi, factoryAbi } from "./abi";

const owner = "0x0000000000000000000000000000000000000001" as Address;
const delegate = "0x0000000000000000000000000000000000000002" as Address;
const registry = "0x0000000000000000000000000000000000000003" as Address;
const resolver = "0x0000000000000000000000000000000000000004" as Address;
const now = 1800000000000;
const request = { ensName: "agent.alice.eth", owner, delegate, action: "publish", policyVersion: 1, policyDigest: "0x" + "a".repeat(64) };
const policy: EnsPublicPolicy = { version: "1", ensName: request.ensName, owner, delegate, digest: request.policyDigest, uri: "https://example.org/public-policy/1", expiresAt: now / 1000 + 3600, actions: ["publish", "negotiate", "reveal", "update-status"], resolverScope: "dedicated-agent" };

function fixture() {
  const state = { granted: true, active: true, broad: false, setterAdmin: false, policy: { ...policy }, chain: 11155111, implementation: ENS_DEPLOYMENT.resolverImplementation as Address, expired: false };
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
    if (functionName === "ROOT_REGISTRY") return ENS_DEPLOYMENT.rootRegistry;
    if (functionName === "isENSv2") return state.active;
    if (functionName === "getSubregistry") return address === ENS_DEPLOYMENT.rootRegistry ? ENS_DEPLOYMENT.ethRegistry : registry;
    if (functionName === "getState") return { status: 2, latestOwner: owner, expiry: BigInt(now / 1000 + (state.expired ? -1 : 7200)), tokenId: 30n, resource: 31n };
    if (functionName === "getResolver" || functionName === "predictProxyAddress") return resolver;
    if (functionName === "verifyContract") return args[0] === registry ? ENS_DEPLOYMENT.registryImplementation : state.implementation;
    if (functionName === "roles") {
      if (args[1] === owner) return BigInt("0x" + "1".repeat(64));
      if (address === resolver && args[0] === textResource(STATUS_KEY)) return (state.granted ? 16n : 0n) | (state.setterAdmin ? 16n << 128n : 0n);
      return state.broad && address === resolver && args[0] === 0n ? 16n : 0n;
    }
    if (functionName === "roleCount") return args[0] === 0n ? BigInt("0x" + "1".repeat(64)) : 0n;
    if (functionName === "hasRoles") return state.granted;
    if (functionName === "getRecordId") return 1n;
    if (functionName === "resolve") return encodeAbiParameters([{ type: "string" }], [JSON.stringify(state.policy)]);
    throw new Error("unexpected_read");
  });
  const call = vi.fn(async () => ({}));
  const client = { getChainId: async () => state.chain, getBlock: async () => ({ number: 100n, timestamp: BigInt(now / 1000) }), readContract, call } as unknown as PublicClient;
  return { state, client, call, readContract, provider: createEnsAuthorityProvider({ client, now: () => now }) };
}

describe("ENSv2 authoritative checks", () => {
  it("fails closed without a configured provider", async () => {
    expect(await createEnsAuthorityProvider().checkAuthority(request)).toMatchObject({ allowed: false, reason: "ens_rpc_not_configured" });
  });
  it("verifies current hierarchy, official implementation, scoped grant and policy", async () => {
    const { provider, readContract } = fixture();
    expect(await provider.checkAuthority(request)).toMatchObject({ allowed: true, policyDigest: policy.digest, blockNumber: "100" });
    expect(readContract.mock.calls.every(([call]) => "blockNumber" in call)).toBe(true);
  });
  it("does not reuse authority after revocation, including in the independent verifier", async () => {
    const { provider, state, client } = fixture();
    expect((await provider.checkAuthority(request)).allowed).toBe(true);
    state.granted = false;
    expect(await provider.checkAuthority(request)).toMatchObject({ allowed: false, reason: "delegation_revoked_or_missing" });
    expect(await verifyEnsIndependently({ client, now: () => now }, request)).toMatchObject({ allowed: false });
  });
  it("rejects root grants and namespace expiry", async () => {
    const { provider, state } = fixture();
    state.broad = true;
    expect((await provider.checkAuthority(request)).reason).toBe("delegate_scope_too_broad");
    state.broad = false;
    state.expired = true;
    expect((await provider.checkAuthority(request)).reason).toBe("namespace_unregistered_or_expired");
  });
  it("rejects unsupported chain and substituted implementation", async () => {
    const { provider, state } = fixture();
    state.chain = 1;
    expect((await provider.checkAuthority(request)).reason).toBe("unsupported_chain");
    state.chain = 11155111;
    state.implementation = owner;
    expect((await provider.checkAuthority(request)).reason).toBe("unsupported_contract_implementation");
  });
  it("denies inactive ENSv2 even when the configured registry addresses match", async () => {
    const { provider, state } = fixture();
    state.active = false;
    expect(await provider.checkAuthority(request)).toMatchObject({ allowed: false, reason: "ensv2_not_active" });
  });
  it("rejects setter administrators who could regrant themselves after revocation", async () => {
    const { provider, state } = fixture();
    state.setterAdmin = true;
    expect((await provider.checkAuthority(request)).reason).toBe("delegate_setter_admin_or_extra_roles");
  });
  it("allows the owner to publish a paused inline policy while denying delegated activity", async () => {
    const { provider, state, call } = fixture();
    const inline = { version: 1, purpose: "mentor", allowedFields: ["headline"], allowedActions: ["publish"], expiresAt: new Date(now + 3600000).toISOString(), paused: true };
    const pausedRecord = { ...policy, uri: encodeInlinePolicyUri(inline), digest: inlinePolicyDigest(inline), actions: ["publish", "update-status"] };
    const transaction = await provider.prepareTransaction({ operation: "set-policy", ensName: request.ensName, owner, delegate, value: JSON.stringify(pausedRecord) });
    expect(transaction.from).toBe(owner);
    expect(call).toHaveBeenCalledOnce();
    state.policy = pausedRecord;
    expect(await provider.checkAuthority({ ...request, policyDigest: pausedRecord.digest })).toMatchObject({ allowed: false, reason: "inline_policy_paused" });
  });
  it("rejects policy replay, substituted digest and expired policies", async () => {
    const { provider, state } = fixture();
    expect((await provider.checkAuthority({ ...request, policyVersion: 2 })).reason).toBe("policy_version_mismatch");
    expect((await provider.checkAuthority({ ...request, policyDigest: "0x" + "b".repeat(64) })).reason).toBe("policy_digest_mismatch");
    state.policy.expiresAt = now / 1000;
    expect((await provider.checkAuthority(request)).reason).toBe("policy_expired");
  });
  it("does not expose arbitrary RPC error bodies", async () => {
    const { provider, readContract } = fixture();
    readContract.mockRejectedValue(new Error("RPC authentication secret payload"));
    expect((await provider.checkAuthority(request)).reason).toBe("ens_verification_failed");
  });
  it("denies a stale latest head without trying any older authority snapshot", async () => {
    const { client, readContract } = fixture();
    const getBlock = vi.fn(async () => ({ number: 100n, timestamp: BigInt(now / 1000 - 91) }));
    client.getBlock = getBlock as unknown as PublicClient["getBlock"];
    const provider = createEnsAuthorityProvider({ client, now: () => now });
    expect(await provider.checkAuthority(request)).toMatchObject({ allowed: false, reason: "stale_chain_head" });
    expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockTag: "latest" });
    expect(readContract).not.toHaveBeenCalled();
  });
  it("closes the viem RPC client and suppresses cleanup failures", async () => {
    const { client } = fixture();
    const close = vi.fn();
    Object.defineProperty(client, "transport", { value: { getRpcClient: async () => ({ close }) }, configurable: true });
    await createEnsAuthorityProvider({ client }).disconnect();
    expect(close).toHaveBeenCalledOnce();
    Object.defineProperty(client, "transport", { value: { getRpcClient: async () => { throw new Error("endpoint credentials must remain private"); } } });
    await expect(createEnsAuthorityProvider({ client }).disconnect()).resolves.toBeUndefined();
  });
  it("denies a snapshot that becomes stale before successful verification finishes", async () => {
    const { client, readContract } = fixture();
    let current = now;
    const original = readContract.getMockImplementation()!;
    readContract.mockImplementation(async (parameters) => {
      const value = await original(parameters);
      if (parameters.functionName === "resolve") current = now + 91000;
      return value;
    });
    const result = await createEnsAuthorityProvider({ client, now: () => current }).checkAuthority(request);
    expect(result).toMatchObject({ allowed: false, reason: "stale_chain_head", checkedAt: new Date(now + 91000).toISOString() });
  });
  it("starts a fresh latest context after a 429 and observes a new revocation", async () => {
    const { client, state, readContract } = fixture();
    let snapshots = 0;
    const getBlock = vi.fn(async (parameters: { blockTag: string }) => {
      expect(parameters.blockTag).toBe("latest");
      return { number: 100n + BigInt(snapshots++), timestamp: BigInt(now / 1000) };
    });
    client.getBlock = getBlock as unknown as PublicClient["getBlock"];
    const original = readContract.getMockImplementation()!;
    let limited = false;
    readContract.mockImplementation(async (parameters) => {
      if (!limited && parameters.functionName === "ROOT_REGISTRY") {
        limited = true; state.granted = false;
        throw Object.assign(new Error("Limited"), { cause: { status: 429, name: "HttpRequestError" } });
      }
      return original(parameters);
    });
    const result = await createEnsAuthorityProvider({ client, now: () => now }).checkAuthority(request);
    expect(result).toMatchObject({ allowed: false, reason: "delegation_revoked_or_missing", blockNumber: "101" });
    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(getBlock.mock.calls.every((parameters) => parameters.length === 1 && (parameters[0] as { blockTag: string }).blockTag === "latest")).toBe(true);
  });
  it("prepares actual scoped grants and revocation without signing", async () => {
    const { provider, call } = fixture();
    const grant = await provider.prepareTransaction({ ...request, operation: "grant" });
    const revoke = await provider.prepareTransaction({ ...request, operation: "revoke" });
    expect(grant).toMatchObject({ to: resolver, from: owner, value: "0x0", chainId: 11155111 });
    expect(grant.data).not.toBe(revoke.data);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("rejects forbidden delegated keys before simulation", async () => {
    const { provider, call } = fixture();
    await expect(provider.prepareTransaction({ ...request, operation: "update-status", key: POLICY_KEY, value: "forged" })).rejects.toThrow("record_not_delegated");
    expect(call).not.toHaveBeenCalled();
    expect(textResource(POLICY_KEY)).not.toBe(textResource(STATUS_KEY));
  });
  it("requires hierarchical lowercase ASCII names and strict public policy", () => {
    for (const name of ["alice.eth", "Agent.alice.eth", "agent..eth", "agent.alice.com"]) expect(() => validateAgentName(name)).toThrow();
    expect(publicPolicySchema.safeParse({ ...policy, privateEmail: "private@example.org" }).success).toBe(false);
    expect(evaluatePublicPolicy(policy, { ...request, action: "send-email" }, now / 1000)).toBe("action_not_delegated");
  });
  it("keeps public discovery records owner-exclusive and never extends the delegate key grant", async () => {
    const { provider, readContract, call } = fixture();
    const original = readContract.getMockImplementation()!;
    readContract.mockImplementation(async (parameters) => {
      if (parameters.functionName === "resolve") return encodeAbiParameters([{ type: "string" }], [""]);
      return original(parameters);
    });
    const prepared = await provider.preparePublicAgentRecord({ ensName: request.ensName, owner, key: "agent-endpoint[meeti-rest-v1]", value: "https://example.org/public-agent" });
    expect(prepared).toMatchObject({ from: owner, to: resolver, key: "agent-endpoint[meeti-rest-v1]" });
    expect(call).toHaveBeenCalledOnce();
    await expect(provider.preparePublicAgentRecord({ ensName: request.ensName, owner: delegate, key: "agent-endpoint[web]", value: "https://example.org/" })).rejects.toThrow("namespace_owner_mismatch");
    readContract.mockImplementation(async (parameters) => parameters.functionName === "roleCount" && parameters.args[0] === textResource("agent-endpoint[web]") ? 16n : original(parameters));
    await expect(provider.readPublicAgentRecords({ ensName: request.ensName, keys: ["agent-endpoint[web]"] })).rejects.toThrow("public_agent_record_not_owner_exclusive");
  });
  it("reuses a project parent registry and issues a chosen label to the recipient wallet", async () => {
    const { provider, readContract, call } = fixture();
    const original = readContract.getMockImplementation()!;
    const labelHash = BigInt(keccak256(stringToHex("user1")));
    let available = true;
    readContract.mockImplementation(async (parameters) => {
      if (parameters.functionName === "roles" && parameters.address === registry && parameters.args[0] === 0n && parameters.args[1] === owner) return 1n;
      if (parameters.functionName === "getState" && parameters.args[0] === labelHash) return { status: available ? 0 : 2, expiry: available ? 0n : 1800007200n, latestOwner: owner, tokenId: 30n, resource: 31n };
      return original(parameters);
    });
    expect(await provider.inspectProjectParent({ parentName: "users.alice.eth", issuer: owner })).toMatchObject({ nextStep: "ready", subregistry: registry });
    const prepared = await provider.prepareProjectSubname({ parentName: "users.alice.eth", label: "user1", issuer: owner, recipient: delegate, expiresAt: now / 1000 + 3600 });
    const decoded = decodeFunctionData({ abi: registryAbi, data: prepared.data });
    expect(decoded.functionName).toBe("register");
    expect(decoded.args?.[1]).toBe(delegate);
    expect(prepared).toMatchObject({ from: owner, to: registry, recipient: delegate, ensName: "user1.users.alice.eth" });
    expect(call).toHaveBeenCalledOnce();
    available = false;
    await expect(provider.prepareProjectSubname({ parentName: "users.alice.eth", label: "user1", issuer: owner, recipient: delegate, expiresAt: now / 1000 + 3600 })).rejects.toThrow("project_subname_not_unused");
    expect(normalizeProjectLabel(" Alice-1 ")).toBe("alice-1");
    await expect(provider.prepareProjectSubname({ parentName: "users.alice.eth", label: "Alice", issuer: owner, recipient: delegate, expiresAt: now / 1000 + 3600 })).rejects.toThrow("project_label_must_be_normalized");
  });
  it("initializes a sponsored recipient registry with only recipient root control", async () => {
    const { provider, readContract, client, call } = fixture();
    const original = readContract.getMockImplementation()!;
    const labelHash = BigInt(keccak256(stringToHex("user1")));
    readContract.mockImplementation(async (parameters) => {
      if (parameters.functionName === "roles" && parameters.address === registry && parameters.args[0] === 0n && parameters.args[1] === owner) return 1n;
      if (parameters.functionName === "getState" && parameters.args[0] === labelHash) return { status: 0, expiry: 0n, latestOwner: owner, tokenId: 30n, resource: 31n };
      return original(parameters);
    });
    client.getCode = vi.fn(async () => undefined);
    const prepared = await provider.prepareProjectRecipientRegistry({ parentName: "users.alice.eth", label: "user1", issuer: owner, recipient: delegate });
    expect(prepared.needed).toBe(true);
    if (!prepared.needed) throw new Error("expected_fixture_deployment");
    const factory = decodeFunctionData({ abi: factoryAbi, data: prepared.data });
    expect(factory.functionName).toBe("deployProxy");
    const initialization = decodeFunctionData({ abi: registryInitAbi, data: factory.args![2] as `0x${string}` });
    expect(initialization.args?.[0]).toEqual([{ account: delegate, roleBitmap: BigInt("0x" + "1".repeat(64)) }]);
    expect(call).toHaveBeenCalledOnce();
  });
});
