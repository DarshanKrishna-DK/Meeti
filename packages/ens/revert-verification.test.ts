import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Address } from "viem";
import { TEXT_ROLE, textResource } from "./index";
import { eacErrorAbi, isForbiddenTextRoleRevert } from "./revert-verification";

const account = "0x0000000000000000000000000000000000000001" as Address;
function denial(key = "network.agent.policy", rejectedAccount = account) {
  return { cause: { data: encodeErrorResult({ abi: eacErrorAbi, errorName: "EACUnauthorizedAccountRoles", args: [textResource(key), TEXT_ROLE, rejectedAccount] }) } };
}
describe("live forbidden setter evidence", () => {
  it("requires the exact EAC role, resource and rejected account", () => {
    expect(isForbiddenTextRoleRevert(denial(), account, "network.agent.policy")).toBe(true);
    expect(isForbiddenTextRoleRevert(denial("network.agent.status"), account, "network.agent.policy")).toBe(false);
    expect(isForbiddenTextRoleRevert(denial(), "0x0000000000000000000000000000000000000002", "network.agent.policy")).toBe(false);
  });
  it("does not mistake generic reverts and provider failures for authorization evidence", () => {
    expect(isForbiddenTextRoleRevert({ name: "ExecutionRevertedError" }, account, "network.agent.policy")).toBe(false);
    expect(isForbiddenTextRoleRevert({ data: "0x08c379a0" }, account, "network.agent.policy")).toBe(false);
    expect(isForbiddenTextRoleRevert(new Error("RPC unavailable"), account, "network.agent.policy")).toBe(false);
  });
});
