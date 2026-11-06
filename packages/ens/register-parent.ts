import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParentPlanIdentity, createParentRegistrationProvider, DEFAULT_PARENT_DURATION, openParentPlan, sealParentPlan, validateParentName, validateParentOwner } from "./parent-registration";

async function main() {
  const [operation, name, ownerInput, ...options] = process.argv.slice(2);
  if (!["quote", "prepare", "reveal"].includes(operation) || !name || !ownerInput) throw new Error("usage_quote_prepare_reveal_name_owner_optional_duration");
  const label = validateParentName(name);
  const owner = validateParentOwner(ownerInput);
  if (options.length !== 0 && (options.length !== 2 || options[0] !== "--duration" || !/^\d+$/.test(options[1]))) throw new Error("invalid_parent_cli_options");
  const duration = options.length ? BigInt(options[1]) : DEFAULT_PARENT_DURATION;
  const provider = createParentRegistrationProvider({ rpcUrl: process.env.ENS_SEPOLIA_RPC_URL });
  if (operation === "quote") {
    console.log(JSON.stringify(await provider.quote(name, owner, duration), null, 2));
    return;
  }
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const directory = resolve(workspace, ".local-data/ens-registration");
  await mkdir(directory, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const canonicalDirectory = await realpath(directory);
  if (!canonicalDirectory.toLowerCase().startsWith((canonicalWorkspace + sep).toLowerCase())) throw new Error("parent_plan_directory_outside_workspace");
  const path = resolve(canonicalDirectory, `${owner.toLowerCase()}-${label}.json`);
  const existing = existsSync(path) ? openParentPlan(await readFile(path, "utf8"), process.env.DATA_ENCRYPTION_KEY) : undefined;
  if (existing) assertParentPlanIdentity(existing, name, owner);
  if (operation === "reveal") {
    if (!existing) throw new Error("parent_plan_missing_prepare_first");
    if (options.length && existing.duration !== duration.toString()) throw new Error("parent_plan_parameters_mismatch");
    console.log(JSON.stringify(await provider.reveal(existing), null, 2));
    return;
  }
  if (!process.env.DATA_ENCRYPTION_KEY) throw new Error("data_encryption_key_not_configured");
  const prepared = await provider.prepare(name, owner, options.length ? duration : existing ? BigInt(existing.duration) : duration, existing);
  if (!existing) await writeFile(path, sealParentPlan(prepared.plan, process.env.DATA_ENCRYPTION_KEY), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...prepared.review, encryptedPlanFile: path, nextCommand: `npx tsx packages/ens/register-parent.ts reveal ${name} ${owner}`, note: "No transaction has been signed or sent. Obtain explicit authorization for each reviewed Sepolia operation. Re-run reveal only after prerequisites are mined and the minimum commitment age has elapsed." }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "parent_preparation_failed";
  const reason = /^[a-z][a-z0-9_]{0,100}$/.test(message) ? message : "parent_rpc_or_validation_failed";
  console.log(JSON.stringify({ prepared: false, reason, broadcast: false, chainId: 11155111 }));
  process.exitCode = 1;
});
