import { describe, expect, it } from "vitest";
import { agentEndpointKey, agentRegistrationKey, encodeEvmInteroperableAddress, publicAgentContextSchema, readRegistrationDataUri, registrationDataUri, registryReference, validatePublicAgentRecordKey, validatePublicAgentRecordValue, validateRegistrationAgreement, type Erc8004Registration } from "./agent-records";

const registry = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const identity = { chainId: 11155111, registry, agentId: "167" };
const registration: Erc8004Registration = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Test agent", description: "A public test description.", services: [{ name: "ENS", endpoint: "agent.alice.eth", version: "v2" }, { name: "meeti-rest-v1", endpoint: "https://example.org/api/public/agents/agent.alice.eth/context", version: "1" }], x402Support: false, active: true, registrations: [{ agentId: identity.agentId, agentRegistry: registryReference(identity) }], supportedTrust: [] };

describe("draft ENS agent record formats", () => {
  it("matches the official ENSIP-25 mainnet ERC-7930 example and binds the Sepolia chain", () => {
    expect(encodeEvmInteroperableAddress(1, "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432")).toBe("0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432");
    expect(agentRegistrationKey(identity)).toBe("agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][167]");
    expect(agentRegistrationKey({ ...identity, chainId: 1 })).not.toBe(agentRegistrationKey(identity));
    expect(validatePublicAgentRecordKey(agentRegistrationKey(identity))).toBe(agentRegistrationKey(identity));
  });
  it("rejects raw addresses, wrong address lengths, noncanonical chains and bracket injection", () => {
    for (const key of [`agent-registration[${registry}][167]`, "agent-registration[0x00010000020001148004a818bfb912233c491871b3d84c89a494bd9e][167]", "agent-registration[0x000100000101138004a818bfb912233c491871b3d84c89a494bd9e][167]"]) expect(() => validatePublicAgentRecordKey(key)).toThrow();
    expect(() => agentRegistrationKey({ ...identity, agentId: "1][2" })).toThrow();
    expect(() => agentRegistrationKey({ ...identity, agentId: (2n ** 256n).toString() })).toThrow();
  });
  it("advertises only the actual custom REST and web protocols", () => {
    expect(agentEndpointKey("meeti-rest-v1")).toBe("agent-endpoint[meeti-rest-v1]");
    const context = { type: "meeti-agent-context-v1", ensName: "agent.alice.eth", name: "Test", description: "Public test.", capabilities: ["discover"], endpoints: [{ protocol: "meeti-rest-v1", url: "https://example.org/agent" }] };
    expect(publicAgentContextSchema.safeParse(context).success).toBe(true);
    expect(publicAgentContextSchema.safeParse({ ...context, employer: "private" }).success).toBe(false);
    expect(publicAgentContextSchema.safeParse({ ...context, endpoints: [{ protocol: "a2a", url: "https://example.org/agent" }] }).success).toBe(false);
    expect(() => validatePublicAgentRecordValue("agent-context", JSON.stringify(context), "agent.bob.eth")).toThrow("agent_context_name_mismatch");
    expect(() => validatePublicAgentRecordValue("agent-endpoint[web]", "https://user:password@example.org/", context.ensName)).toThrow();
  });
  it("requires both the exact registration tuple and claimed ENS service and uses bounded JSON data URIs", () => {
    expect(validateRegistrationAgreement(registration, identity, "agent.alice.eth")).toEqual(registration);
    expect(readRegistrationDataUri(registrationDataUri(registration))).toEqual(registration);
    expect(() => validateRegistrationAgreement(registration, { ...identity, agentId: "168" }, "agent.alice.eth")).toThrow("registration_tuple_mismatch");
    expect(() => validateRegistrationAgreement(registration, identity, "agent.bob.eth")).toThrow("registration_ens_claim_mismatch");
    expect(() => readRegistrationDataUri("https://127.0.0.1/private")).toThrow("registration_uri_scheme_not_supported");
    expect(() => registrationDataUri({ ...registration, supportedTrust: ["reputation"] } as unknown as Erc8004Registration)).toThrow();
  });
});
