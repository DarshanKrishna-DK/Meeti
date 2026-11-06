import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPublicClient, getAddress, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, normalizeProjectLabel } from '../ens';
import { createAgentIdentityProvider, type PreparedIdentityTransaction } from '../ens/agent-identity';
import { AGENT_CONTEXT_KEY, MEETI_AGENT_PROTOCOL, agentEndpointKey, publicAgentContextSchema, registryReference, type AgentRegistryIdentity, type PublicAgentContext } from '../ens/agent-records';
import { createEnsReadTransport } from '../ens/rpc-transport';
import { agent, atomic, audit, db, type UserRow } from './db';
import { decrypt, encrypt } from './crypto';
import { checkOrigin, HttpError, rateLimit, requireUser, requireValue } from './security';

type Stored = { ensName?: string; identity?: AgentRegistryIdentity; context?: PublicAgentContext; receipts: { operation: string; hash: string; blockNumber: string }[] };
type Transaction = { chainId: number; from: string; to: string; data: Hex; value: string; operation: string; ensName: string; gas?: string; gasPrice?: string; key?: string; publicValue?: string };
type Pending = { transaction: Transaction; identityPrepared?: PreparedIdentityTransaction; expiresAt: string; maxFeeWei: string; submittedHash?: Hex; context?: PublicAgentContext; identity?: AgentRegistryIdentity };
function ok(value: unknown) { return Response.json({ data: value }, { headers: { 'Cache-Control': 'no-store' } }); }
function read(userId: string): Stored {
  const row = db().prepare('SELECT data FROM agent_registrations WHERE user_id=?').get(userId) as { data: string } | undefined;
  return row ? decrypt<Stored>(row.data, `agent-registration:${userId}`) : { receipts: [] };
}
function save(userId: string, value: Stored) { db().prepare('INSERT INTO agent_registrations VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(userId, encrypt(value, `agent-registration:${userId}`), new Date().toISOString()); }
function connections() {
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new HttpError(503, 'ENS_UNCONFIGURED', 'Configure the Sepolia connection before managing identity.');
  const ens = createEnsAuthorityProvider({ rpcUrl });
  const identity = createAgentIdentityProvider({ ens, rpcUrl });
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  return { ens, identity, client, async close() {
    await Promise.all([ens.disconnect(), identity.disconnect()]);
    const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }>; getSocket?: () => Promise<{ close(): void }> };
    try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); else if (transport.getSocket) (await transport.getSocket()).close(); } catch { /* Cleanup does not replace the verified outcome. */ }
  } };
}
export function approvedAgentOrigin(): string {
  const url = new URL(process.env.PUBLIC_APP_ORIGIN || process.env.APP_ORIGIN || 'http://localhost');
  if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[|.*\.(local|localhost)$)/i.test(url.hostname)) throw new HttpError(409, 'PUBLIC_ENDPOINT_UNAVAILABLE', 'Configure a publicly reachable HTTPS application origin before publishing agent endpoints. Local development is not a public service.');
  return url.origin;
}
function pending(userId: string, id: string) {
  const row = requireValue(db().prepare("SELECT * FROM operations WHERE id=? AND user_id=? AND kind='identity'").get(id, userId) as { id: string; data: string; state: string } | undefined, 'Identity operation was not found.', 404);
  return { row, value: decrypt<Pending>(row.data, `operation:${id}`) };
}
function requireActor(request: Request, expected: UserRow) {
  const current = requireUser(request);
  if (current.id !== expected.id || current.wallet?.toLowerCase() !== expected.wallet?.toLowerCase()) throw new HttpError(403, 'ACCOUNT_CHANGED', 'Reconnect the original owner account before continuing.');
}
async function storePrepared(request: Request, actor: UserRow, transaction: Transaction, input: Omit<Pending, 'transaction' | 'expiresAt'>, client: ReturnType<typeof connections>['client']) {
  if (transaction.chainId !== 11155111 || transaction.value !== '0x0' || transaction.from.toLowerCase() !== actor.wallet?.toLowerCase()) throw new HttpError(403, 'TRANSACTION_SCOPE_DENIED', 'The prepared transaction does not belong to this Sepolia owner.');
  const [estimate, price] = await Promise.all([client.estimateGas({ account: getAddress(transaction.from), to: getAddress(transaction.to), data: transaction.data, value: 0n }), client.getGasPrice()]);
  const gas = estimate * 120n / 100n, gasPrice = price * 120n / 100n;
  if (gas * gasPrice > BigInt(input.maxFeeWei)) throw new HttpError(409, 'FEE_CAP_EXCEEDED', 'The estimated Sepolia fee exceeds your reviewed limit.');
  return atomic(() => {
    requireActor(request, actor);
    if (db().prepare("SELECT id FROM operations WHERE user_id=? AND state IN ('prepared','submitted')").get(actor.id)) throw new HttpError(409, 'TRANSACTION_UNRESOLVED', 'Reconcile your existing transaction first.');
    const id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    const value: Pending = { ...input, transaction: { ...transaction, gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}` }, expiresAt };
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(id, actor.id, 'identity', 'prepared', encrypt(value, `operation:${id}`), new Date().toISOString());
    return { operationId: id, ...value };
  });
}
const prepareSchema = z.object({ operation: z.enum(['register-identity', 'set-identity-uri', 'attest-association', 'publish-context', 'publish-endpoint']),
  maxFeeWei: z.string().regex(/^[1-9][0-9]{0,16}$/).refine(value => BigInt(value) <= 5000000000000000n),
  name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().min(1).max(1000).optional(), publicApproved: z.literal(true).optional(),
}).strict();

/** Authenticated REST identity management. This endpoint never signs or broadcasts. */
export async function handleIdentity(request: Request, key: string, actor: UserRow, body?: unknown): Promise<Response | null> {
  if (!key.startsWith('identity') && !key.startsWith('namespace')) return null;
  if (!actor.wallet) throw new HttpError(409, 'WALLET_REQUIRED', 'Authenticate with your owner wallet first.');
  const c = connections();
  try {
    if (request.method === 'GET' && key === 'identity') {
      const stored = read(actor.id), current = agent(actor.id);
      const association = stored.identity && current ? await c.identity.verifyAssociation({ identity: stored.identity, ensName: current.ensName, owner: actor.wallet }) : { verified: false, reason: 'registration_not_confirmed' };
      return ok({ ...stored, association, deployment: await c.identity.inspectDeployment(), canPublishEndpoint: (() => { try { approvedAgentOrigin(); return true; } catch { return false; } })() });
    }
    if (request.method !== 'POST') return null;
    checkOrigin(request); rateLimit(`identity:${actor.id}`, 15);
    if (key === 'namespace/inspect') {
      const input = z.object({ label: z.string().max(63).optional() }).strict().parse(body);
      const parentName = process.env.ENS_PROJECT_PARENT || 'meeti-demo.eth';
      const issuer = process.env.ENS_PROJECT_ISSUER;
      if (!issuer) throw new HttpError(503, 'PROJECT_ISSUER_REQUIRED', 'The project owner must configure its verified Sepolia issuer. No sponsorship has been assumed.');
      const parent = await c.ens.inspectProjectParent({ parentName, issuer });
      let namespace = null;
      if (input.label) {
        const label = normalizeProjectLabel(input.label);
        if (['admin', 'agent', 'networking', 'users', 'support', 'api', 'www'].includes(label)) throw new HttpError(400, 'NAME_RESERVED', 'Choose another user name.');
        namespace = { label, userName: `${label}.users.${parentName}`, agentName: `networking.${label}.users.${parentName}`, recipient: actor.wallet };
      }
      requireActor(request, actor);
      return ok({ parent, namespace, sponsorshipEnabled: false, retainedPowers: parent.parentControl, nextStep: 'The issuer must separately prepare and authorize the dedicated users branch before recipient issuance.' });
    }
    const current = requireValue(agent(actor.id), 'Configure or recover your ENS agent first.', 409);
    if (current.owner.toLowerCase() !== actor.wallet.toLowerCase()) throw new HttpError(403, 'OWNER_MISMATCH', 'The authenticated wallet does not own this agent.');
    if (key === 'identity/prepare') {
      const input = prepareSchema.parse(body), stored = read(actor.id);
      let transaction: Transaction, identityPrepared: PreparedIdentityTransaction | undefined, context = stored.context;
      if (input.operation === 'register-identity') {
        if (stored.identity) throw new HttpError(409, 'IDENTITY_EXISTS', 'Use the confirmed identity rather than registering another.');
        identityPrepared = await c.identity.prepareTransaction({ operation: input.operation, ensName: current.ensName, owner: actor.wallet }); transaction = identityPrepared;
      } else if (input.operation === 'set-identity-uri') {
        const identity = requireValue(stored.identity, 'Confirm identity registration first.', 409);
        if (!stored.context) throw new HttpError(409, 'PUBLIC_CONTEXT_REQUIRED', 'Publish an approved public context first.');
        const document = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' as const, name: stored.context.name, description: stored.context.description,
          services: [{ name: 'ENS' as const, endpoint: current.ensName, version: 'v2' as const }, ...stored.context.endpoints.map(endpoint => ({ name: endpoint.protocol, endpoint: endpoint.url, version: '1' as const }))],
          x402Support: false as const, active: true, registrations: [{ agentId: identity.agentId, agentRegistry: registryReference(identity) }], supportedTrust: [] };
        identityPrepared = await c.identity.prepareTransaction({ operation: input.operation, ensName: current.ensName, owner: actor.wallet, identity, document }); transaction = identityPrepared;
      } else if (input.operation === 'attest-association') {
        const identity = requireValue(stored.identity, 'Confirm registration and its metadata first.', 409);
        const association = await c.identity.prepareAssociationRecord({ identity, ensName: current.ensName, owner: actor.wallet });
        transaction = await c.ens.preparePublicAgentRecord(association);
      } else {
        if (!input.publicApproved) throw new HttpError(400, 'PUBLIC_APPROVAL_REQUIRED', 'Review and approve the exact public description first.');
        const endpoint = `${approvedAgentOrigin()}/api/public/agents/${encodeURIComponent(current.ensName)}/context`;
        context = publicAgentContextSchema.parse({ type: 'meeti-agent-context-v1', ensName: current.ensName, name: input.name || stored.context?.name,
          description: input.description || stored.context?.description, capabilities: current.policy.allowedActions,
          endpoints: [{ protocol: MEETI_AGENT_PROTOCOL, url: endpoint }], ...(stored.identity ? { registration: stored.identity } : {}) });
        transaction = await c.ens.preparePublicAgentRecord({ ensName: current.ensName, owner: actor.wallet,
          key: input.operation === 'publish-context' ? AGENT_CONTEXT_KEY : agentEndpointKey(MEETI_AGENT_PROTOCOL), value: input.operation === 'publish-context' ? JSON.stringify(context) : endpoint });
      }
      return ok(await storePrepared(request, actor, transaction, { maxFeeWei: input.maxFeeWei, identityPrepared, context, identity: stored.identity }, c.client));
    }
    if (key === 'identity/submitted' || key === 'identity/confirm') {
      const input = z.object({ operationId: z.string().uuid(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(body);
      const { row, value } = pending(actor.id, input.operationId);
      if (!['prepared', 'submitted', 'confirmed'].includes(row.state) || value.transaction.ensName !== current.ensName || value.transaction.from.toLowerCase() !== actor.wallet.toLowerCase()) throw new HttpError(409, 'OPERATION_CHANGED', 'This operation belongs to a different identity state.');
      if (value.submittedHash && value.submittedHash.toLowerCase() !== input.hash.toLowerCase()) throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Reconcile the recorded transaction hash.');
      if (key.endsWith('/submitted')) {
        requireActor(request, actor);
        if (row.state === 'confirmed') return ok({ confirmed: true });
        if (!value.submittedHash && Date.parse(value.expiresAt) <= Date.now()) throw new HttpError(409, 'PREPARATION_EXPIRED', 'Prepare a fresh review before submitting.');
        db().prepare('UPDATE operations SET state=?,data=? WHERE id=?').run('submitted', encrypt({ ...value, submittedHash: input.hash }, `operation:${row.id}`), row.id);
        return ok({ submitted: true, confirmed: false });
      }
      const result = value.identityPrepared ? await c.identity.confirmTransaction({ hash: input.hash as Hex, prepared: value.identityPrepared })
        : await c.ens.confirmTransaction({ hash: input.hash as Hex, expectedFrom: getAddress(value.transaction.from), expectedTo: getAddress(value.transaction.to), expectedData: value.transaction.data });
      const receipt = await c.client.getTransactionReceipt({ hash: input.hash as Hex });
      if (receipt.gasUsed * receipt.effectiveGasPrice > BigInt(value.maxFeeWei)) throw new HttpError(409, 'FEE_CAP_EXCEEDED', 'The submitted transaction exceeded its reviewed fee cap.');
      if (value.transaction.key) {
        const currentRecord = await c.ens.readPublicAgentRecords({ ensName: current.ensName, owner: actor.wallet, keys: [value.transaction.key] });
        if (currentRecord.records[value.transaction.key] !== value.transaction.publicValue) throw new HttpError(409, 'PUBLIC_READBACK_MISMATCH', 'The confirmed transaction does not match the currently resolved public record.');
        if (value.transaction.key.startsWith('agent-registration[')) {
          const association = await c.identity.verifyAssociation({ identity: requireValue(value.identity, 'Identity tuple was not found.'), ensName: current.ensName, owner: actor.wallet });
          if (!association.verified) throw new HttpError(409, 'ASSOCIATION_UNVERIFIED', 'The registration and ENS attestation do not currently agree.');
        }
      }
      if (value.identityPrepared?.operation === 'set-identity-uri') await c.identity.prepareAssociationRecord({ identity: requireValue(value.identity, 'Identity tuple was not found.'), ensName: current.ensName, owner: actor.wallet });
      return atomic(() => {
        requireActor(request, actor);
        const currentAgent = agent(actor.id);
        if (!currentAgent || currentAgent.ensName !== value.transaction.ensName || currentAgent.owner.toLowerCase() !== actor.wallet!.toLowerCase()) throw new HttpError(409, 'AGENT_CHANGED', 'The owner agent changed during transaction confirmation.');
        const stored = read(actor.id);
        const identity = 'identity' in result && result.identity ? result.identity : value.identity || stored.identity;
        save(actor.id, { ...stored, ensName: current.ensName, identity, ...(value.context ? { context: value.context } : {}), receipts: [...stored.receipts.filter(item => item.hash !== input.hash), { operation: value.transaction.operation, hash: input.hash, blockNumber: result.blockNumber }].slice(-30) });
        db().prepare('UPDATE operations SET state=?,data=? WHERE id=?').run('confirmed', encrypt({ ...value, submittedHash: input.hash }, `operation:${row.id}`), row.id);
        audit(actor.id, 'identity_transaction', 'confirmed', input.hash);
        return ok(result);
      });
    }
    return null;
  } finally { await c.close(); }
}

/** Only the exact currently resolved owner-approved public card is served, never a private profile. */
export async function publicAgentResponse(ensName: string, kind: 'context' | 'registration'): Promise<Response> {
  rateLimit('public-agent:' + ensName, 20);
  const rows = db().prepare('SELECT user_id,data FROM agent_registrations').all() as { user_id: string; data: string }[];
  const match = rows.map(row => ({ userId: row.user_id, value: decrypt<Stored>(row.data, `agent-registration:${row.user_id}`) })).find(row => row.value.ensName === ensName);
  if (!match?.value.context) throw new HttpError(404, 'NOT_FOUND', 'Public agent context was not found.');
  const c = connections();
  try {
    const current = requireValue(agent(match.userId), 'Public agent was not found.', 404);
    const resolved = await c.ens.readPublicAgentRecords({ ensName, owner: current.owner, keys: [AGENT_CONTEXT_KEY, agentEndpointKey(MEETI_AGENT_PROTOCOL)] });
    if (resolved.records[AGENT_CONTEXT_KEY] !== JSON.stringify(match.value.context) || !match.value.context.endpoints.some(endpoint => endpoint.url === resolved.records[agentEndpointKey(MEETI_AGENT_PROTOCOL)])) throw new HttpError(409, 'PUBLIC_RECORD_CHANGED', 'Current ENS public records do not agree with this service.');
    if (kind === 'context') return Response.json({ ...match.value.context, protocol: MEETI_AGENT_PROTOCOL, protocolVersion: '1', supportedMethods: ['GET context', 'GET registration'], checkedAt: resolved.checkedAt }, { headers: { 'Cache-Control': 'no-store' } });
    const identity = requireValue(match.value.identity, 'Agent registration was not found.', 404);
    const association = await c.identity.verifyAssociation({ identity, ensName, owner: current.owner });
    if (!association.verified) throw new HttpError(409, 'ASSOCIATION_UNVERIFIED', 'Current ENS and registry association could not be verified.');
    return Response.json(association.registration, { headers: { 'Cache-Control': 'no-store' } });
  } finally { await c.close(); }
}
