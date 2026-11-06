import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { agentRegistrationKey, agentRegistryIdentitySchema, readRegistrationDataUri, registrationDataUri, validateRegistrationAgreement, type AgentRegistryIdentity, type Erc8004Registration, type EnsPublicRecordsReader } from "./agent-records";
import { createEnsReadTransport } from "./rpc-transport";

export const ERC8004_SEPOLIA = {
  chainId: 11155111,
  registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  implementation: "0x7274e874CA62410a93Bd8bf61c69d8045E399c02",
  proxyCodeHash: "0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41",
  implementationCodeHash: "0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f",
  sourceRevision: "b9e466c250744a7e06b13dff9d3c2844ed64f825",
  version: "2.0.0",
} as const;
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const identityRegistryAbi = parseAbi([
  "function register() returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId,string newURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
export interface IdentityPrepareRequest {
  operation: "register-identity" | "set-identity-uri"; ensName: string; owner: string;
  identity?: AgentRegistryIdentity; document?: Erc8004Registration;
}
export interface PreparedIdentityTransaction {
  chainId: 11155111; from: Address; to: Address; data: Hex; value: "0x0";
  operation: IdentityPrepareRequest["operation"]; ensName: string; agentURI?: string; blockNumber: string;
  warning: string;
}
export interface IdentityProviderOptions {
  ens: EnsPublicRecordsReader; rpcUrl?: string; client?: PublicClient; now?: () => number;
}
function requireCondition(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
function supportedIdentity(input: AgentRegistryIdentity) {
  const identity = agentRegistryIdentitySchema.parse(input);
  requireCondition(identity.chainId === ERC8004_SEPOLIA.chainId && same(identity.registry, ERC8004_SEPOLIA.registry), "unsupported_identity_registry");
  return identity;
}
function publicReason(error: unknown) {
  const reason = error instanceof Error ? error.message : "identity_verification_failed";
  return /^[a-z][a-z0-9_]{0,80}$/.test(reason) ? reason : "identity_verification_failed";
}

export function createAgentIdentityProvider(options: IdentityProviderOptions) {
  const client = options.client ?? (options.rpcUrl ? createPublicClient({ chain: sepolia, transport: createEnsReadTransport(options.rpcUrl) }) as PublicClient : undefined);
  const now = options.now ?? Date.now;
  async function context() {
    requireCondition(client, "identity_rpc_not_configured");
    requireCondition(await client.getChainId() === ERC8004_SEPOLIA.chainId, "unsupported_identity_chain");
    const block = await client.getBlock({ blockTag: "latest" });
    requireCondition(block.number !== null && Math.abs(now() / 1000 - Number(block.timestamp)) < 90, "stale_identity_chain_head");
    const blockNumber = block.number;
    const registry = ERC8004_SEPOLIA.registry;
    const [code, implementationValue] = await Promise.all([
      client.getCode({ address: registry, blockNumber }),
      client.getStorageAt({ address: registry, slot: implementationSlot, blockNumber }),
    ]);
    requireCondition(code && keccak256(code) === ERC8004_SEPOLIA.proxyCodeHash, "identity_proxy_code_changed");
    requireCondition(implementationValue && /^0x0{24}[0-9a-fA-F]{40}$/.test(implementationValue), "identity_implementation_missing");
    requireCondition(same(getAddress("0x" + implementationValue.slice(-40)), ERC8004_SEPOLIA.implementation), "identity_implementation_changed");
    const implementationCode = await client.getCode({ address: ERC8004_SEPOLIA.implementation, blockNumber });
    requireCondition(implementationCode && keccak256(implementationCode) === ERC8004_SEPOLIA.implementationCodeHash, "identity_implementation_code_changed");
    const [erc721, metadata, version] = await Promise.all([
      client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "supportsInterface", args: ["0x80ac58cd"], blockNumber }),
      client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "supportsInterface", args: ["0x5b5e139f"], blockNumber }),
      client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "getVersion", blockNumber }),
    ]);
    requireCondition(erc721 && metadata && version === ERC8004_SEPOLIA.version, "identity_interface_changed");
    function assertFresh() { requireCondition(Math.abs(now() / 1000 - Number(block.timestamp)) < 90, "stale_identity_chain_head"); }
    return { client, registry, blockNumber, assertFresh };
  }

  async function inspectDeployment() {
    try {
      const ctx = await context();
      ctx.assertFresh();
      return { verified: true as const, chainId: ERC8004_SEPOLIA.chainId, registry: ctx.registry, implementation: ERC8004_SEPOLIA.implementation, blockNumber: ctx.blockNumber.toString(), checkedAt: new Date(now()).toISOString(), associationVerified: false as const };
    } catch (error) { return { verified: false as const, reason: publicReason(error), checkedAt: new Date(now()).toISOString(), associationVerified: false as const }; }
  }

  async function prepareTransaction(input: IdentityPrepareRequest): Promise<PreparedIdentityTransaction> {
    const owner = getAddress(input.owner);
    const ctx = await context();
    await options.ens.readPublicAgentRecords({ ensName: input.ensName, owner, keys: [] });
    let data: Hex;
    let agentURI: string | undefined;
    if (input.operation === "register-identity") {
      requireCondition(input.identity === undefined && input.document === undefined, "identity_registration_bootstrap_only");
      data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "register" });
    } else {
      requireCondition(input.operation === "set-identity-uri" && input.identity && input.document, "identity_document_required");
      const identity = supportedIdentity(input.identity);
      const currentOwner = await ctx.client.readContract({ address: ctx.registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [BigInt(identity.agentId)], blockNumber: ctx.blockNumber });
      requireCondition(same(currentOwner, owner), "identity_owner_mismatch");
      const document = validateRegistrationAgreement(input.document, identity, input.ensName);
      agentURI = registrationDataUri(document);
      data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "setAgentURI", args: [BigInt(identity.agentId), agentURI] });
    }
    await ctx.client.call({ account: owner, to: ctx.registry, data, value: 0n, blockNumber: ctx.blockNumber });
    ctx.assertFresh();
    return { chainId: ERC8004_SEPOLIA.chainId, from: owner, to: ctx.registry, data, value: "0x0", operation: input.operation, ensName: input.ensName, agentURI, blockNumber: ctx.blockNumber.toString(), warning: "Owner review and separate Sepolia signature authorization are required. Registration alone does not verify an ENS association. Read the actual receipt ID, publish matching registration metadata and the ENSIP-25 attestation, then verify both sides. Identity metadata grants no EAC permissions." };
  }

  async function confirmTransaction(input: { hash: Hex; prepared: PreparedIdentityTransaction }) {
    const ctx = await context();
    const expected = input.prepared;
    requireCondition(expected.chainId === ERC8004_SEPOLIA.chainId && same(expected.to, ctx.registry) && expected.value === "0x0", "identity_prepared_scope_mismatch");
    const [transaction, receipt] = await Promise.all([ctx.client.getTransaction({ hash: input.hash }), ctx.client.getTransactionReceipt({ hash: input.hash })]);
    requireCondition(receipt.status === "success" && same(transaction.from, expected.from) && transaction.to && same(transaction.to, expected.to) && same(transaction.input, expected.data) && transaction.value === 0n, "identity_receipt_mismatch");
    requireCondition(ctx.blockNumber >= receipt.blockNumber + 1n, "identity_receipt_needs_confirmations");
    const canonical = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
    requireCondition(canonical.hash === receipt.blockHash, "identity_transaction_reorganized");
    let identity: AgentRegistryIdentity | undefined;
    if (expected.operation === "register-identity") {
      const registered = receipt.logs.flatMap((log) => {
        if (!same(log.address, ctx.registry)) return [];
        try { return [decodeEventLog({ abi: identityRegistryAbi, eventName: "Registered", data: log.data, topics: log.topics })]; } catch { return []; }
      });
      requireCondition(registered.length === 1 && same(registered[0].args.owner, expected.from) && registered[0].args.agentURI === "", "identity_registered_event_mismatch");
      identity = { chainId: ERC8004_SEPOLIA.chainId, registry: ctx.registry, agentId: registered[0].args.agentId.toString() };
      const owner = await ctx.client.readContract({ address: ctx.registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [BigInt(identity.agentId)], blockNumber: ctx.blockNumber });
      requireCondition(same(owner, expected.from), "identity_owner_mismatch");
    }
    ctx.assertFresh();
    return { confirmed: true as const, chainId: ERC8004_SEPOLIA.chainId, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), identity, associationVerified: false as const, currentReadbackRequired: true as const };
  }

  async function readRegistration(input: { identity: AgentRegistryIdentity; ensName: string; owner?: string }) {
    const identity = supportedIdentity(input.identity);
    const ctx = await context();
    const [owner, uri] = await Promise.all([
      ctx.client.readContract({ address: ctx.registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [BigInt(identity.agentId)], blockNumber: ctx.blockNumber }),
      ctx.client.readContract({ address: ctx.registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [BigInt(identity.agentId)], blockNumber: ctx.blockNumber }),
    ]);
    requireCondition(!input.owner || same(owner, getAddress(input.owner)), "identity_owner_mismatch");
    const document = validateRegistrationAgreement(readRegistrationDataUri(uri), identity, input.ensName);
    requireCondition(document.active, "identity_registration_inactive");
    ctx.assertFresh();
    return { identity, ctx, owner, uri, document };
  }

  async function prepareAssociationRecord(input: { identity: AgentRegistryIdentity; ensName: string; owner: string }) {
    const { identity, ctx, owner } = await readRegistration(input);
    const key = agentRegistrationKey(identity);
    const ens = await options.ens.readPublicAgentRecords({ ensName: input.ensName, owner, keys: [key] });
    ctx.assertFresh();
    return { ensName: input.ensName, owner, key, value: "1" as const, identity, identityBlockNumber: ctx.blockNumber.toString(), ensBlockNumber: ens.blockNumber, requiresOwnerEnsRecordPreparation: true as const };
  }

  async function verifyAssociation(input: { identity: AgentRegistryIdentity; ensName: string; owner?: string }) {
    try {
      const { identity, ctx, owner, uri, document } = await readRegistration(input);
      const key = agentRegistrationKey(identity);
      const ens = await options.ens.readPublicAgentRecords({ ensName: input.ensName, owner, keys: [key] });
      requireCondition(Boolean(ens.records[key]), "ens_registration_attestation_missing");
      ctx.assertFresh();
      return { verified: true as const, identity, ensName: input.ensName, owner, registration: document, agentURI: uri, attestationKey: key, identityBlockNumber: ctx.blockNumber.toString(), ensBlockNumber: ens.blockNumber, checkedAt: new Date(now()).toISOString(), authorityVerified: false as const };
    } catch (error) { return { verified: false as const, reason: publicReason(error), checkedAt: new Date(now()).toISOString(), authorityVerified: false as const }; }
  }
  async function disconnect() {
    const transport = client?.transport as { getRpcClient?: () => Promise<{ close(): void }>; getSocket?: () => Promise<{ close(): void }> } | undefined;
    try {
      if (transport?.getRpcClient) (await transport.getRpcClient()).close();
      else if (transport?.getSocket) (await transport.getSocket()).close();
    } catch { /* Cleanup must not expose private endpoint details or replace a verification result. */ }
  }
  return { inspectDeployment, prepareTransaction, confirmTransaction, prepareAssociationRecord, verifyAssociation, disconnect };
}
