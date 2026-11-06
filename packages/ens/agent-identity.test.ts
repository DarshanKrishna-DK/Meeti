import { describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, type Address, type PublicClient } from "viem";
import { createAgentIdentityProvider, ERC8004_SEPOLIA, identityRegistryAbi } from "./agent-identity";
import { agentRegistrationKey, registrationDataUri, registryReference, type Erc8004Registration } from "./agent-records";

vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  return { ...original, keccak256: (value: Parameters<typeof original.keccak256>[0]) => value === "0x01" ? "0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41" : value === "0x02" ? "0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f" : original.keccak256(value) };
});
const owner = "0x0000000000000000000000000000000000000001" as Address;
const other = "0x0000000000000000000000000000000000000002" as Address;
const now = 1800000000000;
const identity = { chainId: ERC8004_SEPOLIA.chainId, registry: ERC8004_SEPOLIA.registry, agentId: "17" };
const ensName = "agent.alice.eth";
const document: Erc8004Registration = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Test agent", description: "Public fixture.", services: [{ name: "ENS", endpoint: ensName, version: "v2" }], x402Support: false, active: true, registrations: [{ agentId: identity.agentId, agentRegistry: registryReference(identity) }], supportedTrust: [] };

function fixture() {
  const state = { owner, ensOwner: owner, chain: 11155111, implementation: ERC8004_SEPOLIA.implementation as Address, uri: registrationDataUri(document), attestation: "confirmed", stale: false };
  const call = vi.fn(async () => ({ data: "0x" }));
  const readPublicAgentRecords = vi.fn(async (input: { owner?: string; keys: string[] }) => {
    if (input.owner && input.owner.toLowerCase() !== state.ensOwner.toLowerCase()) throw new Error("namespace_owner_mismatch");
    return { chainId: 11155111, ensName, owner: state.ensOwner, registry: other, resolver: other, blockNumber: "100", blockTimestamp: now / 1000, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), records: Object.fromEntries(input.keys.map((key) => [key, state.attestation])) };
  });
  const client = {
    getChainId: async () => state.chain,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(now / 1000 - (state.stale ? 91 : 0)), hash: "0xabc" }),
    getCode: async ({ address }: { address: Address }) => address === ERC8004_SEPOLIA.registry ? "0x01" : "0x02",
    getStorageAt: async () => "0x" + "0".repeat(24) + state.implementation.slice(2),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "supportsInterface") return true;
      if (functionName === "getVersion") return "2.0.0";
      if (functionName === "ownerOf") return state.owner;
      if (functionName === "tokenURI") return state.uri;
      throw new Error("unexpected_fixture_read");
    }), call,
  } as unknown as PublicClient;
  return { state, client, call, readPublicAgentRecords, provider: createAgentIdentityProvider({ client, ens: { readPublicAgentRecords }, now: () => now }) };
}

describe("minimal ERC-8004 identity association", () => {
  it("requires live matching owners, exact tuple, ENS metadata and an actual nonempty ENS attestation", async () => {
    const { provider, state } = fixture();
    expect(await provider.verifyAssociation({ identity, ensName, owner })).toMatchObject({ verified: true, identity, attestationKey: agentRegistrationKey(identity), authorityVerified: false });
    state.attestation = "";
    expect(await provider.verifyAssociation({ identity, ensName, owner })).toMatchObject({ verified: false, reason: "ens_registration_attestation_missing" });
    state.attestation = "1";
    state.ensOwner = other;
    expect(await provider.verifyAssociation({ identity, ensName, owner })).toMatchObject({ verified: false, reason: "namespace_owner_mismatch" });
  });
  it("denies ownership transfer, altered metadata, unsupported chains and unknown upgrades", async () => {
    const { provider, state } = fixture();
    state.owner = other;
    expect(await provider.verifyAssociation({ identity, ensName, owner })).toMatchObject({ verified: false, reason: "identity_owner_mismatch" });
    state.owner = owner;
    state.uri = registrationDataUri({ ...document, registrations: [{ agentId: "18", agentRegistry: registryReference(identity) }] });
    expect(await provider.verifyAssociation({ identity, ensName, owner })).toMatchObject({ verified: false, reason: "registration_tuple_mismatch" });
    state.implementation = other;
    expect(await provider.inspectDeployment()).toMatchObject({ verified: false, reason: "identity_implementation_changed" });
    state.chain = 1;
    expect(await provider.inspectDeployment()).toMatchObject({ verified: false, reason: "unsupported_identity_chain" });
  });
  it("prepares only owner transactions and derives an attestation only from registered matching metadata", async () => {
    const { provider, state, call } = fixture();
    const registration = await provider.prepareTransaction({ operation: "register-identity", ensName, owner });
    expect(registration).toMatchObject({ from: owner, to: ERC8004_SEPOLIA.registry, operation: "register-identity", value: "0x0" });
    expect(await provider.prepareTransaction({ operation: "set-identity-uri", ensName, owner, identity, document })).toMatchObject({ from: owner, agentURI: state.uri });
    expect(await provider.prepareAssociationRecord({ identity, ensName, owner })).toMatchObject({ key: agentRegistrationKey(identity), value: "1" });
    state.owner = other;
    await expect(provider.prepareTransaction({ operation: "set-identity-uri", ensName, owner, identity, document })).rejects.toThrow("identity_owner_mismatch");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("uses the actual Registered receipt ID and never a simulated next identifier", async () => {
    const { provider, client } = fixture();
    const prepared = await provider.prepareTransaction({ operation: "register-identity", ensName, owner });
    client.getTransaction = vi.fn(async () => ({ from: owner, to: prepared.to, input: prepared.data, value: 0n })) as unknown as PublicClient["getTransaction"];
    client.getTransactionReceipt = vi.fn(async () => ({ status: "success", blockNumber: 98n, blockHash: "0xabc", transactionHash: "0x123", logs: [{ address: prepared.to, topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: 17n, owner } }), data: encodeAbiParameters([{ type: "string" }], [""]) }] })) as unknown as PublicClient["getTransactionReceipt"];
    expect(await provider.confirmTransaction({ hash: "0x123", prepared })).toMatchObject({ confirmed: true, identity, associationVerified: false });
  });
  it("denies stale heads and suppresses private provider error content", async () => {
    const { provider, state, client } = fixture();
    state.stale = true;
    expect(await provider.inspectDeployment()).toMatchObject({ verified: false, reason: "stale_identity_chain_head" });
    state.stale = false;
    client.getCode = vi.fn(async () => { throw new Error("RPC credential and private provider response"); });
    expect(await provider.inspectDeployment()).toMatchObject({ verified: false, reason: "identity_verification_failed" });
  });
  it("closes an independently created socket without exposing cleanup failures", async () => {
    const { client, provider } = fixture();
    const close = vi.fn();
    Object.defineProperty(client, "transport", { value: { getRpcClient: async () => ({ close }) }, configurable: true });
    await provider.disconnect();
    expect(close).toHaveBeenCalledOnce();
    Object.defineProperty(client, "transport", { value: { getRpcClient: async () => { throw new Error("private provider credential"); } } });
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
});
