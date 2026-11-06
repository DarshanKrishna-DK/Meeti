import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPublicClient, getAddress, keccak256, stringToHex, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, ENS_DEPLOYMENT, normalizeProjectLabel } from '../ens';
import { registryAbi } from '../ens/abi';
import { createEnsReadTransport } from '../ens/rpc-transport';
import { atomic, audit, db, type UserRow } from './db';
import { decrypt, encrypt } from './crypto';
import { checkOrigin, HttpError, rateLimit, requireUser, requireValue } from './security';

type ClaimData = { chainId: 11155111; parent: string; userName: string; agentName: string; recipient: string; publicApprovedAt: string; recipientRegistry?: string; userRegistry?: string; resolver: null; agentConfirmed: false; operationId?: string; receipts: { hash: string; blockNumber: string; operation: string }[] };
type ClaimRow = { id: string; user_id: string; label: string; recipient: string; version: number; state: string; data: string; created_at: string; updated_at: string };
type Transaction = { chainId: number; from: string; to: string; data: Hex; value: string; operation: string; ensName: string; predictedAddress?: string; warning?: string; gas?: string; gasPrice?: string };
type Journal = { transaction: Transaction; claimId?: string; claimVersion?: number; maxFeeWei: string; expiresAt: string; submittedHash?: Hex; recipientRegistry?: string };
const feeCap = z.string().regex(/^[1-9][0-9]{0,16}$/).refine(value => BigInt(value) <= 5000000000000000n);
function ok(data: unknown) { return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } }); }
function settings() {
  const parent = process.env.ENS_PROJECT_PARENT || 'meeti-demo.eth';
  const issuer = process.env.ENS_PROJECT_ISSUER;
  if (!issuer) throw new HttpError(503, 'PROJECT_ISSUER_REQUIRED', 'The verified Sepolia project issuer is not configured.');
  return { parent, issuer: getAddress(issuer), branch: `users.${parent}` };
}
function provider() {
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new HttpError(503, 'ENS_UNCONFIGURED', 'The Sepolia read connection is unavailable.');
  const ens = createEnsAuthorityProvider({ rpcUrl });
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  return { ens, client, async close() { await ens.disconnect(); try { const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> }; if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Preserve the checked result. */ } } };
}
function readClaim(id: string) { return requireValue(db().prepare('SELECT * FROM namespace_claims WHERE id=?').get(id) as ClaimRow | undefined, 'Name request was not found.', 404); }
function decode(row: ClaimRow) { return decrypt<ClaimData>(row.data, `namespace-claim:${row.id}`); }
function dto(row: ClaimRow) { return { id: row.id, label: row.label, version: row.version, state: row.state, ...decode(row), updatedAt: row.updated_at }; }
function persist(row: ClaimRow, value: ClaimData, state: string) { db().prepare('UPDATE namespace_claims SET version=version+1,state=?,data=?,updated_at=? WHERE id=? AND version=?').run(state, encrypt(value, `namespace-claim:${row.id}`), new Date().toISOString(), row.id, row.version); }
function currentActor(request: Request, actor: UserRow) { const current = requireUser(request); if (current.id !== actor.id || current.wallet?.toLowerCase() !== actor.wallet?.toLowerCase()) throw new HttpError(403, 'ACCOUNT_CHANGED', 'The authenticated wallet changed. Refresh this request.'); }
function operator(actor: UserRow, issuer: string) { if (actor.wallet?.toLowerCase() !== issuer.toLowerCase()) throw new HttpError(403, 'ISSUER_REQUIRED', 'Only the authenticated project issuer can prepare or confirm issuance.'); }
async function inspect(p: ReturnType<typeof provider>) {
  const config = settings(), parent = await p.ens.inspectProjectParent({ parentName: config.parent, issuer: config.issuer });
  let branch: Awaited<ReturnType<typeof p.ens.inspectProjectParent>> | null = null;
  try { branch = await p.ens.inspectProjectParent({ parentName: config.branch, issuer: config.issuer }); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'namespace_unregistered_or_expired') throw error; }
  return { ...config, parent, branch, nextStep: !branch ? 'create-branch' : branch.nextStep === 'ready' ? 'ready' : branch.nextStep };
}
async function assertAvailable(p: ReturnType<typeof provider>, config: Awaited<ReturnType<typeof inspect>>, label: string) {
  if (!config.branch || config.branch.nextStep !== 'ready') return { confirmedAvailable: false, reason: 'Project namespace setup is pending. This request reserves a local label only.' };
  const state = await p.client.readContract({ address: config.branch.subregistry, abi: registryAbi, functionName: 'getState', args: [BigInt(keccak256(stringToHex(label)))], blockNumber: BigInt(config.branch.blockNumber) });
  if (state.status !== 0 || state.expiry !== 0n) throw new HttpError(409, 'NAME_UNAVAILABLE', 'This name has already been used on Sepolia. Choose another label.');
  return { confirmedAvailable: true, blockNumber: config.branch.blockNumber };
}
async function prepareJournal(request: Request, actor: UserRow, p: ReturnType<typeof provider>, transaction: Transaction, maxFeeWei: string, claim?: ClaimRow, recipientRegistry?: string) {
  if (transaction.from.toLowerCase() !== actor.wallet?.toLowerCase() || transaction.chainId !== 11155111 || transaction.value !== '0x0') throw new HttpError(403, 'TRANSACTION_SCOPE_DENIED', 'This unsigned transaction must belong to the authenticated Sepolia issuer.');
  const [estimate, price] = await Promise.all([p.client.estimateGas({ account: getAddress(transaction.from), to: getAddress(transaction.to), data: transaction.data, value: 0n }), p.client.getGasPrice()]);
  const gas = estimate * 120n / 100n, gasPrice = price * 120n / 100n;
  if (gas * gasPrice > BigInt(maxFeeWei)) throw new HttpError(409, 'FEE_CAP_EXCEEDED', 'The unsigned issuance exceeds your reviewed testnet gas limit.');
  return atomic(() => {
    currentActor(request, actor);
    if (db().prepare("SELECT id FROM operations WHERE user_id=? AND state IN ('prepared','submitted')").get(actor.id)) throw new HttpError(409, 'TRANSACTION_UNRESOLVED', 'Reconcile the existing issuer transaction first.');
    const id = randomUUID();
    if (claim) {
      const fresh = readClaim(claim.id);
      if (fresh.version !== claim.version || ['withdrawn', 'confirmed'].includes(fresh.state)) throw new HttpError(409, 'CLAIM_CHANGED', 'The recipient request changed. Review it again.');
      persist(fresh, { ...decode(fresh), operationId: id, ...(recipientRegistry ? { recipientRegistry } : {}) }, 'prepared');
    }
    const value: Journal = { transaction: { ...transaction, gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}` }, maxFeeWei,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), ...(claim ? { claimId: claim.id, claimVersion: claim.version + 1 } : {}), ...(recipientRegistry ? { recipientRegistry } : {}) };
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(id, actor.id, 'namespace:' + (claim?.id || 'branch'), 'prepared', encrypt(value, `operation:${id}`), new Date().toISOString());
    return { operationId: id, ...value };
  });
}

/** Wallet-owned claims and issuer-signed testnet issuance. This server never holds the issuer signing key. */
export async function handleNamespaceClaims(request: Request, key: string, actor: UserRow, body?: unknown): Promise<Response | null> {
  if (!key.startsWith('namespace/')) return null;
  if (!actor.wallet) throw new HttpError(409, 'WALLET_REQUIRED', 'Authenticate with your wallet to request a name.');
  const config = settings(), isOperator = actor.wallet.toLowerCase() === config.issuer.toLowerCase();
  if (request.method === 'GET' && key === 'namespace/claims') {
    const own = db().prepare('SELECT * FROM namespace_claims WHERE user_id=?').get(actor.id) as ClaimRow | undefined;
    const requests = isOperator ? (db().prepare("SELECT * FROM namespace_claims WHERE state NOT IN ('withdrawn') ORDER BY created_at LIMIT 100").all() as ClaimRow[]).map(dto) : [];
    const operations = (db().prepare("SELECT * FROM operations WHERE user_id=? AND kind LIKE 'namespace:%' AND state IN ('prepared','submitted') ORDER BY created_at LIMIT 10").all(actor.id) as { id: string; state: string; data: string }[]).map(row => ({ operationId: row.id, state: row.state, ...decrypt<Journal>(row.data, `operation:${row.id}`) }));
    return ok({ parent: config.parent, branch: config.branch, issuer: config.issuer, isOperator, claim: own ? dto(own) : null, requests, operations,
      custody: 'The recipient owns its user-name token and registry. The project retains ancestor control. The recipient later signs agent-child and resolver setup with a separate delegate.', sponsorship: 'The issuer pays gas for its own registration transactions only. Recipient transactions require recipient test ETH.' });
  }
  if (request.method !== 'POST') return null;
  checkOrigin(request); rateLimit(`namespace:${actor.id}`, 15);
  const p = provider();
  try {
    if (key === 'namespace/claim') {
      const input = z.object({ label: z.string().min(1).max(63), publicNameAndWalletApproved: z.literal(true) }).strict().parse(body);
      const label = normalizeProjectLabel(input.label);
      if (['users', 'agent', 'networking', 'admin', 'api', 'www', 'support'].includes(label)) throw new HttpError(400, 'NAME_RESERVED', 'Choose another user label.');
      const prior = db().prepare('SELECT * FROM namespace_claims WHERE user_id=?').get(actor.id) as ClaimRow | undefined;
      if (prior && prior.label === label && prior.state !== 'withdrawn') return ok({ claim: dto(prior), recovered: true });
      const inspected = await inspect(p), availability = await assertAvailable(p, inspected, label);
      return atomic(() => {
        currentActor(request, actor);
        const existing = db().prepare('SELECT * FROM namespace_claims WHERE user_id=?').get(actor.id) as ClaimRow | undefined;
        if (existing && existing.label === label && existing.state !== 'withdrawn') return ok({ claim: dto(existing), recovered: true });
        if (existing && !['requested', 'withdrawn'].includes(existing.state)) throw new HttpError(409, 'CLAIM_IN_PROGRESS', 'Reconcile the current name request before changing it.');
        if (db().prepare('SELECT id FROM namespace_claims WHERE label=? AND user_id<>?').get(label, actor.id)) throw new HttpError(409, 'NAME_REQUESTED', 'Another wallet has requested this label. Choose another.');
        const id = existing?.id || randomUUID(), now = new Date().toISOString();
        const value: ClaimData = { chainId: 11155111, parent: config.branch, userName: `${label}.${config.branch}`, agentName: `networking.${label}.${config.branch}`, recipient: getAddress(actor.wallet!), publicApprovedAt: now, resolver: null, agentConfirmed: false, receipts: [] };
        db().prepare('INSERT INTO namespace_claims VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET label=excluded.label,version=namespace_claims.version+1,state=excluded.state,data=excluded.data,updated_at=excluded.updated_at')
          .run(id, actor.id, label, actor.wallet!.toLowerCase(), 1, 'requested', encrypt(value, `namespace-claim:${id}`), now, now);
        audit(actor.id, 'namespace_claim', 'requested', 'Approved public user-name and wallet association requested; no chain issuance has occurred.');
        return ok({ claim: dto(readClaim(id)), availability });
      });
    }
    if (key === 'namespace/withdraw') {
      const { version } = z.object({ version: z.number().int().positive() }).strict().parse(body);
      return atomic(() => {
        currentActor(request, actor);
        const row = requireValue(db().prepare('SELECT * FROM namespace_claims WHERE user_id=?').get(actor.id) as ClaimRow | undefined, 'Request was not found.', 404);
        if (row.version !== version || row.state !== 'requested') throw new HttpError(409, 'CLAIM_IN_PROGRESS', 'Only a current unsigned request can be withdrawn.');
        persist(row, decode(row), 'withdrawn'); return ok({ withdrawn: true });
      });
    }
    if (key === 'namespace/setup') { operator(actor, config.issuer); z.object({}).strict().parse(body); return ok(await inspect(p)); }
    if (key === 'namespace/prepare-branch') {
      operator(actor, config.issuer);
      const input = z.object({ maxFeeWei: feeCap }).strict().parse(body), inspected = await inspect(p);
      if (inspected.parent.nextStep !== 'ready') throw new HttpError(409, 'PROJECT_PARENT_NOT_READY', 'Complete the existing parent registry setup first.');
      if (inspected.nextStep === 'ready') return ok({ needed: false, inspected });
      const transaction = inspected.nextStep === 'create-branch'
        ? await p.ens.prepareProjectSubname({ parentName: config.parent, label: 'users', issuer: config.issuer, recipient: config.issuer, expiresAt: Math.floor(Date.parse(inspected.parent.expiresAt) / 1000) })
        // This registry-only helper requires a distinct validation address. No delegate role is granted by either operation.
        : await p.ens.prepareTransaction({ operation: inspected.nextStep === 'deploy-registry' ? 'deploy-registry' : 'set-subregistry', ensName: `candidate.${config.branch}`, owner: config.issuer, delegate: ENS_DEPLOYMENT.factory });
      return ok(await prepareJournal(request, actor, p, transaction, input.maxFeeWei));
    }
    if (key === 'namespace/prepare-claim') {
      operator(actor, config.issuer);
      const input = z.object({ claimId: z.string().uuid(), version: z.number().int().positive(), maxFeeWei: feeCap }).strict().parse(body);
      const row = readClaim(input.claimId), value = decode(row);
      if (row.version !== input.version || ['confirmed', 'withdrawn'].includes(row.state)) throw new HttpError(409, 'CLAIM_CHANGED', 'Refresh the recipient name request.');
      const inspected = await inspect(p);
      if (inspected.nextStep !== 'ready') throw new HttpError(409, 'NAMESPACE_SETUP_REQUIRED', 'The issuer must confirm the project users namespace first.');
      await assertAvailable(p, inspected, row.label);
      const registry = await p.ens.prepareProjectRecipientRegistry({ parentName: config.branch, label: row.label, issuer: config.issuer, recipient: value.recipient });
      const transaction = registry.needed ? registry : await p.ens.prepareProjectSubname({ parentName: config.branch, label: row.label, issuer: config.issuer, recipient: value.recipient,
        expiresAt: Math.floor(Date.parse(inspected.branch!.expiresAt) / 1000), recipientSubregistry: registry.predictedAddress });
      return ok(await prepareJournal(request, actor, p, transaction, input.maxFeeWei, row, registry.predictedAddress));
    }
    if (key === 'namespace/submitted' || key === 'namespace/confirm') {
      operator(actor, config.issuer);
      const input = z.object({ operationId: z.string().uuid(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(body);
      const operation = requireValue(db().prepare("SELECT * FROM operations WHERE id=? AND user_id=? AND kind LIKE 'namespace:%'").get(input.operationId, actor.id) as { id: string; state: string; data: string } | undefined, 'Issuer operation was not found.', 404);
      const value = decrypt<Journal>(operation.data, `operation:${operation.id}`);
      if (!['prepared', 'submitted', 'confirmed'].includes(operation.state) || (value.submittedHash && value.submittedHash.toLowerCase() !== input.hash.toLowerCase())) throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Reconcile the exact recorded issuer transaction.');
      if (key === 'namespace/submitted') {
        currentActor(request, actor);
        if (!value.submittedHash && Date.parse(value.expiresAt) <= Date.now()) throw new HttpError(409, 'PREPARATION_EXPIRED', 'The unsigned review expired. Prepare a fresh transaction.');
        if (operation.state !== 'confirmed') db().prepare('UPDATE operations SET state=?,data=? WHERE id=?').run('submitted', encrypt({ ...value, submittedHash: input.hash }, `operation:${operation.id}`), operation.id);
        return ok({ submitted: true, confirmed: operation.state === 'confirmed' });
      }
      const confirmed = await p.ens.confirmTransaction({ hash: input.hash as Hex, expectedFrom: getAddress(value.transaction.from), expectedTo: getAddress(value.transaction.to), expectedData: value.transaction.data });
      const receipt = await p.client.getTransactionReceipt({ hash: input.hash as Hex });
      if (receipt.gasUsed * receipt.effectiveGasPrice > BigInt(value.maxFeeWei)) throw new HttpError(409, 'FEE_CAP_EXCEEDED', 'This transaction exceeded its reviewed fee cap.');
      if (operation.state === 'confirmed') { currentActor(request, actor); return ok({ ...confirmed, alreadyConfirmed: true, currentNamespaceCheckRequired: true }); }
      let readback: unknown;
      if (value.claimId) {
        const claim = readClaim(value.claimId), details = decode(claim);
        readback = value.transaction.operation === 'deploy-recipient-registry'
          ? await p.ens.prepareProjectRecipientRegistry({ parentName: config.branch, label: claim.label, issuer: config.issuer, recipient: details.recipient })
          : await p.ens.inspectProjectParent({ parentName: details.userName, issuer: details.recipient });
        if ('needed' in (readback as object) && (readback as { needed: boolean }).needed) throw new HttpError(409, 'REGISTRY_READBACK_FAILED', 'The recipient registry is not confirmed onchain.');
      } else readback = await inspect(p);
      return atomic(() => {
        currentActor(request, actor);
        if (value.claimId) {
          const row = readClaim(value.claimId), details = decode(row);
          if (row.version !== value.claimVersion || details.operationId !== operation.id) {
            if (operation.state === 'confirmed') return ok({ ...confirmed, readback });
            throw new HttpError(409, 'CLAIM_CHANGED', 'The recipient request changed while confirming.');
          }
          const issued = value.transaction.operation === 'issue-project-subname';
          persist(row, { ...details, ...(issued ? { userRegistry: value.transaction.to } : {}), recipientRegistry: value.recipientRegistry,
            receipts: [...details.receipts, { hash: input.hash, blockNumber: confirmed.blockNumber, operation: value.transaction.operation }] }, issued ? 'confirmed' : 'requested');
          audit(row.user_id, 'namespace_claim', issued ? 'confirmed' : 'registry_confirmed', `Sepolia receipt ${input.hash}. Agent child and resolver remain unconfirmed.`);
        }
        db().prepare('UPDATE operations SET state=?,data=? WHERE id=?').run('confirmed', encrypt({ ...value, submittedHash: input.hash }, `operation:${operation.id}`), operation.id);
        return ok({ ...confirmed, readback });
      });
    }
    return null;
  } finally { await p.close(); }
}
