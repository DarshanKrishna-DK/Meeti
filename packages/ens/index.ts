import {
  createPublicClient, decodeFunctionResult, encodeAbiParameters, encodeFunctionData,
  getAddress, keccak256, namehash, stringToHex, zeroAddress,
  type Address, type Hex, type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";
import { factoryAbi, registryAbi, registryInitAbi, resolverAbi, textProfileAbi, universalAbi } from "./abi";
import { createEnsReadTransport } from "./rpc-transport";

export const ENS_CHAIN_ID = 11155111;
export const ENS_DEPLOYMENT = {
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  rootRegistry: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  factory: "0xda70306c98e97ece36f997a21368e53298572991",
  resolverImplementation: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  registryImplementation: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
} as const satisfies Record<string, Address>;
export const POLICY_KEY = "network.agent.policy";
export const STATUS_KEY = "network.agent.status";
export const TEXT_ROLE = 1n << 4n;
const TEXT_ADMIN = TEXT_ROLE << 128n;
const ALL_ROLES = BigInt("0x" + "1".repeat(64));
const NAME_ROLES = (1n << 12n) | (1n << 16n) | (1n << 20n) | (1n << 24n);
const NAME_OWNER_ROLES = NAME_ROLES | (NAME_ROLES << 128n) | (1n << 156n);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const INLINE_POLICY_PREFIX = "data:application/json;base64,";
const policyActionSchema = z.enum(["discover", "publish", "evaluate", "negotiate", "introduce", "message"]);
export const inlinePolicySchema = z.object({
  version: z.number().int().positive().safe(),
  purpose: z.enum(["cofounder", "collaborator", "mentor", "teammate"]),
  allowedFields: z.array(z.enum(["displayName", "headline", "bio", "offering", "seeking", "tags", "contact", "employer"])).max(8).refine((values) => new Set(values).size === values.length),
  allowedActions: z.array(policyActionSchema).min(1).max(6).refine((values) => new Set(values).size === values.length),
  expiresAt: z.string().datetime({ offset: true }),
  paused: z.boolean(),
}).strict();
export type EnsInlinePolicy = z.infer<typeof inlinePolicySchema>;
function canonicalInlinePolicy(policy: unknown): string {
  const value = inlinePolicySchema.parse(policy);
  return JSON.stringify({ version: value.version, purpose: value.purpose, allowedFields: [...value.allowedFields].sort(), allowedActions: [...value.allowedActions].sort(), expiresAt: value.expiresAt, paused: value.paused });
}
export function inlinePolicyDigest(policy: unknown): Hex { return keccak256(stringToHex(canonicalInlinePolicy(policy))); }
export function encodeInlinePolicyUri(policy: unknown): string {
  const bytes = new TextEncoder().encode(canonicalInlinePolicy(policy));
  requireCondition(bytes.length <= 2048, "inline_policy_too_large");
  return INLINE_POLICY_PREFIX + btoa(String.fromCharCode(...bytes));
}
export function decodeInlinePolicyUri(uri: string): EnsInlinePolicy {
  requireCondition(uri.startsWith(INLINE_POLICY_PREFIX) && uri.length <= 4096, "invalid_inline_policy_uri");
  const encoded = uri.slice(INLINE_POLICY_PREFIX.length);
  requireCondition(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), "invalid_inline_policy_encoding");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  requireCondition(bytes.length > 0 && bytes.length <= 2048, "inline_policy_too_large");
  return inlinePolicySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
const publicPolicyUriSchema = z.string().max(4096).refine((uri) => {
  if (uri.startsWith(INLINE_POLICY_PREFIX)) { try { decodeInlinePolicyUri(uri); return true; } catch { return false; } }
  try { const parsed = new URL(uri); return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && uri.length <= 2048; } catch { return false; }
}, "Public policy URI must be HTTPS or validated inline policy JSON.");
export const publicPolicySchema = z.object({
  version: z.string().min(1).max(64),
  ensName: z.string().min(1).max(253),
  owner: addressSchema,
  delegate: addressSchema,
  digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  uri: publicPolicyUriSchema,
  expiresAt: z.number().int().positive().safe(),
  actions: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/)).min(1).max(16),
  resolverScope: z.literal("dedicated-agent"),
}).strict();
export type EnsPublicPolicy = z.infer<typeof publicPolicySchema>;
export interface EnsAuthorityRequest {
  ensName: string;
  owner: string;
  delegate: string;
  action: string;
  policyVersion?: string | number;
  policyDigest?: string;
}
export interface EnsAuthorityResult {
  allowed: boolean;
  reason: string;
  checkedAt: string;
  chainId: number;
  expiresAt?: string;
  blockNumber?: string;
  policyDigest?: string;
  publicPolicy?: EnsPublicPolicy;
  evidence?: { registry: Address; resolver: Address; resource: string; network: "sepolia" };
}
export interface EnsNamespaceBinding {
  ensName: string;
  owner: string;
  delegate: string;
  resolverAddress?: string;
  policyDigest?: string;
}
export type EnsOperation = "deploy-resolver" | "set-resolver" | "set-policy" | "grant" | "revoke" | "update-status" | "deploy-registry" | "set-subregistry" | "create-subname";
export interface EnsPrepareRequest {
  operation: EnsOperation;
  ensName: string;
  owner: string;
  delegate: string;
  key?: string;
  value?: string;
  expiresAt?: number;
}
export interface PreparedEnsTransaction {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: "0x0";
  operation: EnsOperation;
  ensName: string;
  predictedAddress?: Address;
  warning: string;
}
export interface EnsProviderOptions {
  rpcUrl?: string;
  namespace?: EnsNamespaceBinding;
  client?: PublicClient;
  now?: () => number;
}

function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
function requireCondition(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function transientAuthorityRead(error: unknown): boolean {
  let cause = error as { code?: unknown; status?: unknown; name?: string; cause?: unknown } | undefined;
  for (let depth = 0; cause && depth < 10; depth++, cause = cause.cause as typeof cause) {
    if (cause.code === -32001 || cause.status === 429 || cause.status === 503 || cause.name === "TimeoutError") return true;
  }
  return false;
}
export function validateAgentName(value: string): string {
  const labels = value.split(".");
  requireCondition(value === value.toLowerCase() && value.length <= 253 && labels.length >= 3 && labels.length <= 8 && labels.at(-1) === "eth", "unsupported_agent_name");
  requireCondition(labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "unsupported_agent_name");
  return value;
}
export function dnsEncode(name: string): Hex {
  return ("0x" + name.split(".").map((label) => label.length.toString(16).padStart(2, "0") + stringToHex(label).slice(2)).join("") + "00") as Hex;
}
export function textResource(key: string): bigint { return BigInt(keccak256(stringToHex(key))); }
export function dedicatedResolverSalt(name: string, owner: Address): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }], [keccak256(stringToHex("MeetiAgentResolver:v1")), namehash(name), owner])));
}
function registrySalt(parent: string): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(stringToHex("UserRegistry")), namehash(parent), 0n])));
}
function labelId(label: string) { return BigInt(keccak256(stringToHex(label))); }
function setTextData(name: string, key: string, value: string): Hex {
  return encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dnsEncode(name), key, value] });
}
export function evaluatePublicPolicy(policy: EnsPublicPolicy, request: EnsAuthorityRequest, nowSeconds: number, options: { allowPausedOwnerRecord?: boolean } = {}): string | undefined {
  if (policy.ensName !== request.ensName || !same(policy.owner, request.owner) || !same(policy.delegate, request.delegate)) return "policy_identity_mismatch";
  if (policy.expiresAt <= nowSeconds) return "policy_expired";
  if (request.policyVersion !== undefined && policy.version !== String(request.policyVersion)) return "policy_version_mismatch";
  if (request.policyDigest !== undefined && !same(policy.digest, request.policyDigest)) return "policy_digest_mismatch";
  if (policy.uri.startsWith(INLINE_POLICY_PREFIX)) {
    let inline: EnsInlinePolicy;
    try { inline = decodeInlinePolicyUri(policy.uri); } catch { return "inline_policy_invalid"; }
    if (!same(inlinePolicyDigest(inline), policy.digest)) return "inline_policy_digest_mismatch";
    if (inline.paused && !options.allowPausedOwnerRecord) return "inline_policy_paused";
    if (String(inline.version) !== policy.version) return "inline_policy_version_mismatch";
    if (Math.floor(Date.parse(inline.expiresAt) / 1000) !== policy.expiresAt) return "inline_policy_expiry_mismatch";
    const applicationActions = policy.actions.filter((action) => action !== "update-status");
    const maintenanceCount = policy.actions.length - applicationActions.length;
    if (maintenanceCount > 1 || JSON.stringify([...inline.allowedActions].sort()) !== JSON.stringify(applicationActions.sort())) return "inline_policy_actions_mismatch";
  } else if (request.policyDigest === undefined) return "expected_policy_digest_required";
  if (!policy.actions.includes(request.action)) return "action_not_delegated";
  return undefined;
}

export function createEnsAuthorityProvider(options: EnsProviderOptions = {}) {
  const client = options.client ?? (options.rpcUrl ? createPublicClient({ chain: sepolia,
    transport: createEnsReadTransport(options.rpcUrl),
  }) as PublicClient : undefined);
  const now = options.now ?? Date.now;
  async function context() {
    requireCondition(client, "ens_rpc_not_configured");
    requireCondition(await client.getChainId() === ENS_CHAIN_ID, "unsupported_chain");
    const block = await client.getBlock({ blockTag: "latest" });
    requireCondition(block.number !== null && Math.abs(now() / 1000 - Number(block.timestamp)) < 90, "stale_chain_head");
    const blockNumber = block.number;
    const read = async <T>(address: Address, abi: typeof registryAbi | typeof resolverAbi | typeof factoryAbi | typeof universalAbi, functionName: string, args: readonly unknown[] = []): Promise<T> => {
      return await client.readContract({ address, abi, functionName, args, blockNumber } as Parameters<PublicClient["readContract"]>[0]) as T;
    };
    const [root, active] = await Promise.all([
      read<Address>(ENS_DEPLOYMENT.universalResolver, universalAbi, "ROOT_REGISTRY"),
      read<boolean>(ENS_DEPLOYMENT.universalResolver, universalAbi, "isENSv2"),
    ]);
    requireCondition(active && same(root, ENS_DEPLOYMENT.rootRegistry), "ensv2_not_active");
    const eth = await read<Address>(root, registryAbi, "getSubregistry", ["eth"]);
    requireCondition(same(eth, ENS_DEPLOYMENT.ethRegistry), "unexpected_eth_registry");
    async function verifyProxy(address: Address, implementation: Address) {
      const actual = await read<Address>(ENS_DEPLOYMENT.factory, factoryAbi, "verifyContract", [address]);
      requireCondition(same(actual, implementation), "unsupported_contract_implementation");
    }
    async function locate(name: string) {
      let registry: Address = eth;
      const labels = name.split(".");
      let expiry = Number.MAX_SAFE_INTEGER;
      const path: { registry: Address; resource: bigint }[] = [];
      for (let i = labels.length - 2; i >= 0; i--) {
        const label = labels[i];
        const state = await read<{ status: number; expiry: bigint; latestOwner: Address; tokenId: bigint; resource: bigint }>(registry, registryAbi, "getState", [labelId(label)]);
        requireCondition(state.status === 2 && state.expiry > block.timestamp, "namespace_unregistered_or_expired");
        path.push({ registry, resource: state.resource });
        expiry = Math.min(expiry, Number(state.expiry));
        if (i === 0) return { registry, label, state, expiry, path };
        const next = await read<Address>(registry, registryAbi, "getSubregistry", [label]);
        requireCondition(!same(next, zeroAddress), "namespace_subregistry_missing");
        await verifyProxy(next, ENS_DEPLOYMENT.registryImplementation);
        registry = next;
      }
      throw new Error("namespace_missing");
    }
    return { read, locate, verifyProxy, blockNumber, block };
  }
  function identities(request: { ensName: string; owner: string; delegate: string }) {
    validateAgentName(request.ensName);
    const owner = getAddress(request.owner);
    const delegate = getAddress(request.delegate);
    requireCondition(!same(owner, delegate) && !same(owner, zeroAddress) && !same(delegate, zeroAddress), "distinct_owner_delegate_required");
    const binding = options.namespace;
    if (binding) requireCondition(binding.ensName === request.ensName && same(binding.owner, owner) && same(binding.delegate, delegate), "namespace_binding_mismatch");
    return { owner, delegate };
  }
  async function checkAuthorityAttempt(request: EnsAuthorityRequest, attempt: number): Promise<EnsAuthorityResult> {
    const result: EnsAuthorityResult = { allowed: false, reason: "ens_unavailable", checkedAt: new Date(now()).toISOString(), chainId: ENS_CHAIN_ID };
    try {
      const { owner, delegate } = identities(request);
      const ctx = await context();
      result.blockNumber = ctx.blockNumber.toString();
      const location = await ctx.locate(request.ensName);
      requireCondition(same(location.state.latestOwner, owner), "namespace_owner_mismatch");
      const resolver = await ctx.read<Address>(location.registry, registryAbi, "getResolver", [location.label]);
      await ctx.verifyProxy(resolver, ENS_DEPLOYMENT.resolverImplementation);
      const predicted = await ctx.read<Address>(ENS_DEPLOYMENT.factory, factoryAbi, "predictProxyAddress", [owner, dedicatedResolverSalt(request.ensName, owner)]);
      requireCondition(same(predicted, resolver), "dedicated_resolver_required");
      if (options.namespace?.resolverAddress) requireCondition(same(resolver, options.namespace.resolverAddress), "resolver_binding_mismatch");
      const [ownerRoles, rootCount, delegateRoot, policyCount, allowed, registryRoot, registryName, recordId] = await Promise.all([
        ctx.read<bigint>(resolver, resolverAbi, "roles", [0n, owner]),
        ctx.read<bigint>(resolver, resolverAbi, "roleCount", [0n]),
        ctx.read<bigint>(resolver, resolverAbi, "roles", [0n, delegate]),
        ctx.read<bigint>(resolver, resolverAbi, "roleCount", [textResource(POLICY_KEY)]),
        ctx.read<boolean>(resolver, resolverAbi, "hasRoles", [textResource(STATUS_KEY), TEXT_ROLE, delegate]),
        ctx.read<bigint>(location.registry, registryAbi, "roles", [0n, delegate]),
        ctx.read<bigint>(location.registry, registryAbi, "roles", [location.state.resource, delegate]),
        ctx.read<bigint>(resolver, resolverAbi, "getRecordId", [namehash(request.ensName)]),
      ]);
      requireCondition((ownerRoles & (TEXT_ROLE | TEXT_ADMIN)) === (TEXT_ROLE | TEXT_ADMIN) && rootCount === ownerRoles, "resolver_root_control_not_exclusive");
      requireCondition(delegateRoot === 0n && registryRoot === 0n && registryName === 0n && policyCount === 0n, "delegate_scope_too_broad");
      const statusRoles = await ctx.read<bigint>(resolver, resolverAbi, "roles", [textResource(STATUS_KEY), delegate]);
      requireCondition(statusRoles === (allowed ? TEXT_ROLE : 0n), "delegate_setter_admin_or_extra_roles");
      for (const ancestor of location.path.slice(0, -1)) {
        const [rootRoles, nameRoles] = await Promise.all([
          ctx.read<bigint>(ancestor.registry, registryAbi, "roles", [0n, delegate]),
          ctx.read<bigint>(ancestor.registry, registryAbi, "roles", [ancestor.resource, delegate]),
        ]);
        requireCondition(rootRoles === 0n && nameRoles === 0n, "delegate_ancestor_control_too_broad");
      }
      requireCondition(allowed, "delegation_revoked_or_missing");
      requireCondition(recordId > 0n, "dedicated_record_required");
      const profile = encodeFunctionData({ abi: textProfileAbi, functionName: "text", args: [namehash(request.ensName), POLICY_KEY] });
      const encoded = await ctx.read<Hex>(resolver, resolverAbi, "resolve", [dnsEncode(request.ensName), profile]);
      const raw = decodeFunctionResult({ abi: textProfileAbi, functionName: "text", data: encoded });
      requireCondition(raw.length <= 16384, "policy_record_too_large");
      const policy = publicPolicySchema.parse(JSON.parse(raw));
      const policyRequest = { ...request, policyDigest: request.policyDigest ?? options.namespace?.policyDigest };
      const denial = evaluatePublicPolicy(policy, policyRequest, Math.max(now() / 1000, Number(ctx.block.timestamp)));
      requireCondition(!denial, denial ?? "policy_invalid");
      requireCondition(Math.abs(now() / 1000 - Number(ctx.block.timestamp)) < 90, "stale_chain_head");
      result.allowed = true;
      result.reason = "current_ensv2_delegation_verified";
      result.policyDigest = policy.digest;
      result.publicPolicy = policy;
      result.expiresAt = new Date(Math.min(location.expiry, policy.expiresAt) * 1000).toISOString();
      result.evidence = { registry: location.registry, resolver, resource: location.state.resource.toString(), network: "sepolia" };
    } catch (error) {
      if (attempt === 0 && transientAuthorityRead(error)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return checkAuthorityAttempt(request, 1);
      }
      const reason = error instanceof Error ? error.message : "ens_unavailable";
      result.reason = /^[a-z][a-z0-9_]{0,80}$/.test(reason) ? reason : "ens_verification_failed";
    }
    result.checkedAt = new Date(now()).toISOString();
    return result;
  }
  async function checkAuthority(request: EnsAuthorityRequest): Promise<EnsAuthorityResult> {
    return checkAuthorityAttempt(request, 0);
  }

  async function prepareTransaction(request: EnsPrepareRequest): Promise<PreparedEnsTransaction> {
    const { owner, delegate } = identities(request);
    const ctx = await context();
    const result: PreparedEnsTransaction = { chainId: ENS_CHAIN_ID, from: owner, to: ENS_DEPLOYMENT.factory, data: "0x", value: "0x0", operation: request.operation, ensName: request.ensName, warning: "Sepolia transaction requires wallet review and signature. Resolver key permissions apply to every name served by this resolver. Policy expiry is enforced by current verifier checks, not by EAC itself." };
    const parentName = request.ensName.split(".").slice(1).join(".");
    if (["deploy-registry", "set-subregistry", "create-subname"].includes(request.operation)) {
      const parent = await ctx.locate(parentName);
      requireCondition(same(parent.state.latestOwner, owner), "parent_owner_mismatch");
      const salt = registrySalt(parentName);
      const predicted = await ctx.read<Address>(ENS_DEPLOYMENT.factory, factoryAbi, "predictProxyAddress", [owner, salt]);
      result.predictedAddress = predicted;
      if (request.operation === "deploy-registry") {
        const init = encodeFunctionData({ abi: registryInitAbi, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }]] });
        result.data = encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [ENS_DEPLOYMENT.registryImplementation, salt, init] });
      } else if (request.operation === "set-subregistry") {
        await ctx.verifyProxy(predicted, ENS_DEPLOYMENT.registryImplementation);
        const current = await ctx.read<Address>(parent.registry, registryAbi, "getSubregistry", [parent.label]);
        requireCondition(same(current, zeroAddress) || same(current, predicted), "existing_subregistry_replacement_blocked");
        result.to = parent.registry;
        result.data = encodeFunctionData({ abi: registryAbi, functionName: "setSubregistry", args: [labelId(parent.label), predicted] });
      } else {
        const subregistry = await ctx.read<Address>(parent.registry, registryAbi, "getSubregistry", [parent.label]);
        await ctx.verifyProxy(subregistry, ENS_DEPLOYMENT.registryImplementation);
        const expiresAt = request.expiresAt;
        requireCondition(expiresAt && Number.isSafeInteger(expiresAt) && expiresAt > Number(ctx.block.timestamp) && expiresAt <= parent.expiry, "invalid_namespace_expiry");
        result.to = subregistry;
        result.data = encodeFunctionData({ abi: registryAbi, functionName: "register", args: [request.ensName.split(".")[0], owner, zeroAddress, zeroAddress, NAME_OWNER_ROLES, BigInt(expiresAt)] });
      }
    } else {
      const location = await ctx.locate(request.ensName);
      requireCondition(same(location.state.latestOwner, owner), "namespace_owner_mismatch");
      const salt = dedicatedResolverSalt(request.ensName, owner);
      const resolver = await ctx.read<Address>(ENS_DEPLOYMENT.factory, factoryAbi, "predictProxyAddress", [owner, salt]);
      result.predictedAddress = resolver;
      if (request.operation === "deploy-resolver") {
        const init = encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] });
        result.data = encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [ENS_DEPLOYMENT.resolverImplementation, salt, init] });
      } else {
        await ctx.verifyProxy(resolver, ENS_DEPLOYMENT.resolverImplementation);
        result.to = resolver;
        if (request.operation === "set-resolver") {
          result.to = location.registry;
          result.data = encodeFunctionData({ abi: registryAbi, functionName: "setResolver", args: [labelId(location.label), resolver] });
        } else {
          const current = await ctx.read<Address>(location.registry, registryAbi, "getResolver", [location.label]);
          requireCondition(same(current, resolver), "dedicated_resolver_not_assigned");
          if (request.operation === "set-policy") {
            const policy = publicPolicySchema.parse(JSON.parse(request.value ?? ""));
            const denial = evaluatePublicPolicy(policy, { ...request, action: policy.actions[0], policyDigest: options.namespace?.policyDigest }, now() / 1000, { allowPausedOwnerRecord: true });
            requireCondition(!denial, denial ?? "policy_invalid");
            result.data = setTextData(request.ensName, POLICY_KEY, JSON.stringify(policy));
          } else if (request.operation === "grant") {
            result.data = encodeFunctionData({ abi: resolverAbi, functionName: "grantSetterRoles", args: [setTextData(request.ensName, STATUS_KEY, ""), delegate] });
          } else if (request.operation === "revoke") {
            result.data = encodeFunctionData({ abi: resolverAbi, functionName: "revokeRoles", args: [textResource(STATUS_KEY), TEXT_ROLE, delegate] });
          } else {
            requireCondition(request.operation === "update-status" && (request.key === undefined || request.key === STATUS_KEY), "record_not_delegated");
            requireCondition(typeof request.value === "string" && request.value.length <= 2048, "invalid_status_value");
            const authority = await checkAuthority({ ...request, action: "update-status" });
            requireCondition(authority.allowed, authority.reason);
            result.from = delegate;
            result.data = setTextData(request.ensName, STATUS_KEY, request.value);
          }
        }
      }
    }
    requireCondition(client, "ens_rpc_not_configured");
    await client.call({ account: result.from, to: result.to, data: result.data, value: 0n, blockNumber: ctx.blockNumber });
    requireCondition(Math.abs(now() / 1000 - Number(ctx.block.timestamp)) < 90, "stale_chain_head");
    return result;
  }

  async function confirmTransaction(input: { hash: Hex; expectedFrom: Address; expectedTo: Address; expectedData: Hex }) {
    requireCondition(client, "ens_rpc_not_configured");
    await context();
    const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: input.hash }), client.getTransactionReceipt({ hash: input.hash })]);
    requireCondition(receipt.status === "success" && same(transaction.from, input.expectedFrom) && transaction.to && same(transaction.to, input.expectedTo) && same(transaction.input, input.expectedData) && transaction.value === 0n, "transaction_confirmation_mismatch");
    const head = await client.getBlock({ blockTag: "latest" });
    requireCondition(head.number !== null && head.number >= receipt.blockNumber + 1n, "transaction_needs_confirmations");
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    requireCondition(canonical.hash === receipt.blockHash, "transaction_reorganized");
    return { confirmed: true as const, chainId: ENS_CHAIN_ID, blockNumber: receipt.blockNumber.toString(), transactionHash: receipt.transactionHash, explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`, authorityReadbackRequired: true as const };
  }
  async function disconnect() {
    const transport = client?.transport as { getRpcClient?: () => Promise<{ close(): void }>; getSocket?: () => Promise<{ close(): void }> } | undefined;
    try {
      if (transport?.getRpcClient) (await transport.getRpcClient()).close();
      else if (transport?.getSocket) (await transport.getSocket()).close();
    } catch { /* Cleanup must not replace a fail-closed result or expose endpoint credentials. */ }
  }
  return { checkAuthority, prepareTransaction, confirmTransaction, disconnect };
}

export async function verifyEnsIndependently(options: Pick<EnsProviderOptions, "rpcUrl" | "client" | "now">, request: EnsAuthorityRequest) {
  const provider = createEnsAuthorityProvider(options);
  try { return await provider.checkAuthority(request); }
  finally { if (!options.client) await provider.disconnect(); }
}
