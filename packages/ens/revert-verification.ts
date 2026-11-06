import { decodeErrorResult, parseAbi, type Address, type Hex } from "viem";
import { TEXT_ROLE, textResource } from "./index";

export const eacErrorAbi = parseAbi([
  "error EACUnauthorizedAccountRoles(uint256 resource,uint256 roleBitmap,address account)",
]);

export function isForbiddenTextRoleRevert(error: unknown, account: Address, key: string): boolean {
  let cause = error as { data?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cause && depth < 10; depth++, cause = cause.cause as typeof cause) {
    const value = typeof cause.data === "string" ? cause.data : (cause.data as { data?: unknown } | undefined)?.data;
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) continue;
    try {
      const decoded = decodeErrorResult({ abi: eacErrorAbi, data: value as Hex });
      const [resource, roleBitmap, rejectedAccount] = decoded.args;
      if (decoded.errorName === "EACUnauthorizedAccountRoles" && resource === textResource(key) && roleBitmap === TEXT_ROLE && rejectedAccount.toLowerCase() === account.toLowerCase()) return true;
    } catch { /* An unrelated revert or malformed RPC payload is not EAC denial evidence. */ }
  }
  return false;
}
