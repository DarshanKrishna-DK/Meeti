import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

export const AGENT_CONTEXT_KEY = "agent-context";
export const MEETI_AGENT_PROTOCOL = "meeti-rest-v1";
export const agentEndpointProtocolSchema = z.enum([MEETI_AGENT_PROTOCOL, "web"]);
export type AgentEndpointProtocol = z.infer<typeof agentEndpointProtocolSchema>;
const decimalId = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine((value) => BigInt(value) < 2n ** 256n);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
export const agentRegistryIdentitySchema = z.object({
  chainId: z.number().int().positive().safe(), registry: address, agentId: decimalId,
}).strict();
export type AgentRegistryIdentity = z.infer<typeof agentRegistryIdentitySchema>;
const httpsUrl = z.string().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "";
  } catch { return false; }
}, "A public HTTPS URL without credentials or a fragment is required.");
const ensName = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.eth$/);

export const publicAgentContextSchema = z.object({
  type: z.literal("meeti-agent-context-v1"),
  ensName,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  capabilities: z.array(z.enum(["discover", "publish", "evaluate", "negotiate", "introduce", "message"])).max(6)
    .refine((values) => new Set(values).size === values.length),
  endpoints: z.array(z.object({ protocol: agentEndpointProtocolSchema, url: httpsUrl }).strict()).min(1).max(2)
    .refine((values) => new Set(values.map((value) => value.protocol)).size === values.length),
  registration: agentRegistryIdentitySchema.optional(),
}).strict();
export type PublicAgentContext = z.infer<typeof publicAgentContextSchema>;

export function agentEndpointKey(protocol: AgentEndpointProtocol): string {
  return `agent-endpoint[${agentEndpointProtocolSchema.parse(protocol)}]`;
}

// ERC-7930 version 1, EIP-155 namespace 0x0000, minimal big-endian chain reference, 20-byte address.
export function encodeEvmInteroperableAddress(chainId: number, registry: string): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("unsupported_registry_chain");
  let reference = BigInt(chainId).toString(16);
  if (reference.length % 2) reference = "0" + reference;
  const length = (reference.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${length}${reference}14${getAddress(registry).slice(2).toLowerCase()}` as Hex;
}

export function agentRegistrationKey(identity: AgentRegistryIdentity): string {
  const value = agentRegistryIdentitySchema.parse(identity);
  return `agent-registration[${encodeEvmInteroperableAddress(value.chainId, value.registry)}][${value.agentId}]`;
}

export function validatePublicAgentRecordKey(key: string): string {
  if (key === AGENT_CONTEXT_KEY || key === agentEndpointKey(MEETI_AGENT_PROTOCOL) || key === agentEndpointKey("web")) return key;
  const match = /^agent-registration\[(0x00010000[0-9a-f]+)\]\[(0|[1-9][0-9]*)\]$/.exec(key);
  if (!match) throw new Error("unsupported_public_agent_record");
  const encoded = match[1];
  const referenceLength = Number.parseInt(encoded.slice(10, 12), 16);
  const referenceEnd = 12 + referenceLength * 2;
  const reference = encoded.slice(12, referenceEnd);
  if (!referenceLength || referenceLength > 7 || reference.startsWith("00") || encoded.slice(referenceEnd, referenceEnd + 2) !== "14" || encoded.length !== referenceEnd + 42) throw new Error("invalid_registry_interoperable_address");
  const chainId = Number(BigInt("0x" + reference));
  const registry = getAddress("0x" + encoded.slice(referenceEnd + 2));
  if (agentRegistrationKey({ chainId, registry, agentId: match[2] }) !== key) throw new Error("noncanonical_registration_key");
  return key;
}

export function validatePublicAgentRecordValue(key: string, value: string, expectedEnsName: string): string {
  validatePublicAgentRecordKey(key);
  if (value === "") return value;
  if (key === AGENT_CONTEXT_KEY) {
    const context = publicAgentContextSchema.parse(JSON.parse(value));
    if (context.ensName !== expectedEnsName) throw new Error("agent_context_name_mismatch");
    return JSON.stringify(context);
  }
  if (key.startsWith("agent-endpoint[")) return httpsUrl.parse(value);
  if (value !== "1") throw new Error("unsupported_registration_attestation_value");
  return value;
}

export interface EnsPublicRecords {
  chainId: number; ensName: string; owner: Address; registry: Address; resolver: Address;
  blockNumber: string; blockTimestamp: number; checkedAt: string; expiresAt: string; records: Record<string, string>;
}
export interface EnsPublicRecordsReader {
  readPublicAgentRecords(input: { ensName: string; owner?: string; keys: string[] }): Promise<EnsPublicRecords>;
}

export const erc8004RegistrationSchema = z.object({
  type: z.literal("https://eips.ethereum.org/EIPS/eip-8004#registration-v1"),
  name: z.string().min(1).max(120), description: z.string().min(1).max(1000), image: httpsUrl.optional(),
  services: z.array(z.union([
    z.object({ name: z.literal("ENS"), endpoint: ensName, version: z.literal("v2") }).strict(),
    z.object({ name: z.enum([MEETI_AGENT_PROTOCOL, "web"]), endpoint: httpsUrl, version: z.literal("1") }).strict(),
  ])).min(1).max(3).refine((values) => new Set(values.map((value) => value.name)).size === values.length),
  x402Support: z.literal(false), active: z.boolean(),
  registrations: z.array(z.object({
    agentId: z.union([decimalId, z.number().int().nonnegative().safe().transform(String)]),
    agentRegistry: z.string().regex(/^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/),
  }).strict()).max(1),
  supportedTrust: z.array(z.never()).max(0),
}).strict();
export type Erc8004Registration = z.infer<typeof erc8004RegistrationSchema>;

export function registryReference(identity: Pick<AgentRegistryIdentity, "chainId" | "registry">): string {
  return `eip155:${identity.chainId}:${getAddress(identity.registry)}`;
}

export function validateRegistrationAgreement(document: unknown, identity: AgentRegistryIdentity, claimedEnsName: string): Erc8004Registration {
  const value = erc8004RegistrationSchema.parse(document);
  const tuple = agentRegistryIdentitySchema.parse(identity);
  const claim = value.services.find((service) => service.name === "ENS");
  if (claim?.endpoint !== claimedEnsName) throw new Error("registration_ens_claim_mismatch");
  const registration = value.registrations[0];
  if (value.registrations.length !== 1 || registration.agentId !== tuple.agentId || registration.agentRegistry.toLowerCase() !== registryReference(tuple).toLowerCase()) throw new Error("registration_tuple_mismatch");
  return value;
}

export function registrationDataUri(document: Erc8004Registration): string {
  const json = JSON.stringify(erc8004RegistrationSchema.parse(document));
  if (new TextEncoder().encode(json).length > 8192) throw new Error("registration_document_too_large");
  return "data:application/json;base64," + Buffer.from(json, "utf8").toString("base64");
}

export function readRegistrationDataUri(uri: string): unknown {
  const prefix = "data:application/json;base64,";
  if (!uri.startsWith(prefix)) throw new Error("registration_uri_scheme_not_supported");
  const value = uri.slice(prefix.length);
  if (value.length > 10924 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("registration_uri_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 8192 || bytes.length === 0) throw new Error("registration_document_too_large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
