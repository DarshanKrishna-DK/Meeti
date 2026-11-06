import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { decodeInlinePolicyUri, encodeInlinePolicyUri, evaluatePublicPolicy, inlinePolicyDigest, publicPolicySchema, type EnsInlinePolicy, type EnsPublicPolicy } from "./index";

const owner = "0x0000000000000000000000000000000000000001";
const delegate = "0x0000000000000000000000000000000000000002";
const inline: EnsInlinePolicy = { version: 1, purpose: "mentor", allowedFields: ["seeking", "headline"], allowedActions: ["publish", "discover"], expiresAt: "2028-01-01T00:00:00.000Z", paused: false };
function record(value: EnsInlinePolicy = inline): EnsPublicPolicy {
  return { version: String(value.version), ensName: "agent.example.eth", owner, delegate, uri: encodeInlinePolicyUri(value), digest: inlinePolicyDigest(value), expiresAt: Math.floor(Date.parse(value.expiresAt) / 1000), actions: [...value.allowedActions, "update-status"], resolverScope: "dedicated-agent" };
}
function evaluate(policy: EnsPublicPolicy, action = "publish") {
  return evaluatePublicPolicy(policy, { ensName: policy.ensName, owner, delegate, action, policyVersion: policy.version, policyDigest: policy.digest }, Date.parse("2027-01-01T00:00:00.000Z") / 1000);
}
describe("portable inline ENS disclosure policies", () => {
  it("matches the server canonical digest and sorts permission arrays", () => {
    const expected = keccak256(stringToHex(JSON.stringify({ version: inline.version, purpose: inline.purpose, allowedFields: [...inline.allowedFields].sort(), allowedActions: [...inline.allowedActions].sort(), expiresAt: inline.expiresAt, paused: inline.paused })));
    expect(inlinePolicyDigest(inline)).toBe(expected);
    expect(decodeInlinePolicyUri(encodeInlinePolicyUri(inline))).toEqual({ ...inline, allowedFields: [...inline.allowedFields].sort(), allowedActions: [...inline.allowedActions].sort() });
    expect(evaluate(record())).toBeUndefined();
    expect(evaluate(record(), "update-status")).toBeUndefined();
  });
  it("allows field class labels while rejecting values, unknown fields and unknown actions", () => {
    expect(() => encodeInlinePolicyUri({ ...inline, allowedFields: ["contact", "employer"] })).not.toThrow();
    expect(() => encodeInlinePolicyUri({ ...inline, contact: "private@example.org" })).toThrow();
    expect(() => encodeInlinePolicyUri({ ...inline, allowedFields: ["private@example.org"] })).toThrow();
    expect(() => encodeInlinePolicyUri({ ...inline, allowedActions: ["send-email"] })).toThrow();
  });
  it("rejects malformed and oversized data URIs", () => {
    for (const uri of ["data:application/json;base64,@@@", "data:text/plain;base64,e30=", "data:application/json;base64," + "A".repeat(5000), "data:application/json;base64,e30="]) expect(publicPolicySchema.safeParse({ ...record(), uri }).success).toBe(false);
  });
  it("rejects digest substitution and paused inline policies", () => {
    expect(evaluate({ ...record(), digest: "0x" + "1".repeat(64) })).toBe("inline_policy_digest_mismatch");
    expect(evaluate(record({ ...inline, paused: true }))).toBe("inline_policy_paused");
  });
  it("rejects public record version, expiry and action drift", () => {
    expect(evaluate({ ...record(), version: "2" })).toBe("inline_policy_version_mismatch");
    expect(evaluate({ ...record(), expiresAt: record().expiresAt + 1 })).toBe("inline_policy_expiry_mismatch");
    expect(evaluate({ ...record(), actions: [...record().actions, "message"] })).toBe("inline_policy_actions_mismatch");
    expect(evaluate({ ...record(), actions: [...record().actions, "update-status"] })).toBe("inline_policy_actions_mismatch");
  });
  it("requires an expected digest for externally hosted policy references", () => {
    const policy = { ...record(), uri: "https://example.org/public-policy/1" };
    const request = { ensName: policy.ensName, owner, delegate, action: "publish" };
    expect(evaluatePublicPolicy(policy, request, 1)).toBe("expected_policy_digest_required");
    expect(evaluatePublicPolicy(policy, { ...request, policyDigest: policy.digest }, 1)).toBeUndefined();
  });
});
