import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAddress, verifyMessage } from 'viem';
import { agent, atomic, audit, db, intent, profile, saveAgent, saveIntent, type IntentRow, type UserRow } from './store';
import { decrypt, encrypt, hash, hashPassword, verifyPassword } from './crypto';
import { checkOrigin, createSession, HttpError, rateLimit, readBody, requireUser, requireValue, sessionTokenHash } from './security';
import { enqueueAgentTask, readAgentTask, listAgentTasks } from './agent-tasks';
import { parseEnsFeeCap, quoteEnsTransactionFees, verifyEnsReceiptFee } from './ens-fee-quote';
import { addressSchema, agentSchema, goalSchema, hexSchema, intentInputSchema, profileSchema, tagsSchema } from './validation';
import { ai, arkiv, assertIntent, authority, ensProvider, policyDigest, publicIntent, inferenceProvider } from './policy';
import { consent, createProposal, openRoom, ownedProposal, proposalDtos, roomAccess, assertPair, validatePair } from './proposals';
import { intentSigningMessage } from '../arkiv/src';
import { verifyEnsIndependently, encodeInlinePolicyUri, type EnsOperation } from '../ens';
import { AgentError } from '../agents/src';
import { startWorld, pollWorld, cancelWorld } from './world';
import type { Agent, Intent, Profile, Room } from '../shared/src';
import { normalizeTopics } from '../shared/src/topics';
import { worldEnabled } from './capabilities';
import { discoverCandidates, clearEmbeddingCache } from './discovery';
import { MatchingError } from '../matching/src/embeddings';
import { assertIntentEvidence, interpretIntent } from '../matching/src/semantics';
import { handleWalletAuth } from './wallet-auth';
import { handleOnboarding } from './onboarding';
import { handleAgentImport } from './agent-import';
import { agentRuns, withAgentRun } from './agent-runs';
import { handleContext } from './context';
import { policyHistory } from './policy-history';
import { approvedDocumentContext, deleteStoredDocument, listDocuments } from './context-store';
import { discoveryJobs, queueDiscovery, rememberDiscovery, setDiscoveryEnabled } from './discovery-jobs';
import { meetingAction, meetingDto } from './meetings';
import { continueIntake, profileIntakes } from './profile-intake';
import { listQualificationDtos, answerQualification, resumeQualification, retryQualification, cancelQualification } from './qualifications';
import { handleIdentity, publicAgentResponse } from './identity';
import { requestAutoQualification, listAutoQualifications, cancelAutoQualification } from './auto-qualification';
function ok(data: unknown, cookie?: string): Response {
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
async function listIntents(userId: string): Promise<Intent[]> {
    return (await db().prepare('SELECT * FROM intents WHERE user_id=? ORDER BY rowid DESC').all(userId) as IntentRow[]).map(row => {
        const value = decrypt<Intent>(row.data, `intent:${row.id}`);
        return Date.parse(value.expiresAt) <= Date.now() ? { ...value, status: 'expired' } : value;
    });
}
function diagnostics() {
    const status = (configured: boolean, message: string) => ({ configured, status: configured ? 'ready' : 'unconfigured', message });
    return {
        ens: status(Boolean(process.env.ENS_SEPOLIA_RPC_URL), process.env.ENS_SEPOLIA_RPC_URL ? 'Sepolia RPC configured. Each action checks live permissions.' : 'Configure ENS_SEPOLIA_RPC_URL. No agent authority has been assumed.'),
        arkiv: status(Boolean(process.env.ARKIV_ACCESS_KEY), process.env.ARKIV_ACCESS_KEY ? 'Rabdi discovery configured. Results require a live query.' : 'Configure ARKIV_ACCESS_KEY to publish and query public intents.'),
        ai: status(Boolean(process.env.AI_API_KEY && process.env.AI_MODEL && process.env.AI_INPUT_USD_PER_MILLION && process.env.AI_OUTPUT_USD_PER_MILLION), 'Real model calls require endpoint, key, model, token prices and owner consent.'),
        world: worldEnabled() ? status(Boolean(process.env.WORLD_CLIENT_ID && process.env.WORLD_CLIENT_SECRET), 'World Agent Pass requires fresh server verification from both participants.') : { configured: Boolean(process.env.WORLD_CLIENT_ID && process.env.WORLD_CLIENT_SECRET), status: 'deferred', message: 'World is paused by the owner after application and sandbox login returned HTTP 403. Protected introductions remain locked.' },
    };
}
async function state(actor: UserRow) {
    const roomRows = await db().prepare('SELECT rooms.* FROM rooms JOIN proposals ON proposals.id=rooms.proposal_id WHERE proposals.left_user=? OR proposals.right_user=?').all(actor.id, actor.id) as {
        id: string;
        data: string;
    }[];
    return { user: { id: actor.id, email: actor.email.endsWith('@wallet.meeti.invalid') ? '' : actor.email, wallet: actor.wallet }, profile: await profile(actor.id), agent: await agent(actor.id), intents: await listIntents(actor.id),
        proposals: await proposalDtos(actor.id), agentRuns: await agentRuns(actor.id), agentTasks: await listAgentTasks(actor.id), rooms: roomRows.map(row => { const r = decrypt<Room>(row.data, `room:${row.id}`); return { ...r, introduction: '' }; }),
        audit: (await db().prepare('SELECT * FROM audit WHERE user_id=? ORDER BY rowid DESC LIMIT 100').all(actor.id) as {
            id: string;
            action: string;
            outcome: string;
            detail: string;
            created_at: string;
        }[])
            .map(x => ({ id: x.id, action: x.action, outcome: x.outcome, detail: x.detail, createdAt: x.created_at })), integrations: diagnostics() };
}
async function ownIntent(userId: string, id: string) {
    const i = requireValue(await intent(id), 'Networking intent was not found.', 404);
    if (i.userId !== userId)
        throw new HttpError(404, 'NOT_FOUND', 'Networking intent was not found.');
    return i.value;
}
async function operation(userId: string, id: string, kind: string) {
    const row = await db().prepare('SELECT * FROM operations WHERE id=? AND user_id=? AND kind=?').get(id, userId, kind) as {
        id: string;
        data: string;
        state: string;
        created_at: string;
    } | undefined;
    return requireValue(row, 'The prepared operation was not found.', 404);
}
async function saveOperation(userId: string, kind: string, data: unknown) {
    return await atomic(async () => {
        if (await db().prepare('SELECT id FROM operations WHERE user_id=? AND state IN (?,?)').get(userId, 'prepared', 'submitted'))
            throw new HttpError(409, 'TRANSACTION_UNRESOLVED', 'Reconcile your existing prepared or submitted transaction before preparing another.');
        const id = randomUUID();
        await db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(id, userId, kind, 'prepared', encrypt(data, `operation:${id}`), new Date().toISOString());
        return id;
    });
}
function requireAgentSnapshot(expected: Agent, current: Agent) {
    if (expected.id !== current.id || expected.ensName !== current.ensName || expected.owner !== current.owner || expected.delegate !== current.delegate
        || policyDigest(expected.policy) !== policyDigest(current.policy) || JSON.stringify(expected.config) !== JSON.stringify(current.config))
        throw new HttpError(409, 'STATE_CHANGED', 'Agent identity or permissions changed during this operation. Review the current state.');
}
async function requireRequestActor(request: Request, actor: UserRow) {
    const current = await requireUser(request);
    if (current.id !== actor.id || current.wallet?.toLowerCase() !== actor.wallet?.toLowerCase()) throw new HttpError(403, 'ACCOUNT_CHANGED', 'Sign in again before continuing.');
}
export async function route(request: Request, path: string[]): Promise<Response> {
    try {
        const key = path.join('/');
        if (request.method === 'GET') {
            if (key === 'health')
                return ok({ status: 'ok', storage: process.env.DATABASE_PROVIDER || (process.env.SUPABASE_DATABASE_URL ? 'postgres' : 'sqlite'), integrations: diagnostics() });
            if (path[0] === 'public' && path[1] === 'agents' && path.length === 4 && ['context', 'registration'].includes(path[3])) {
                await rateLimit('public-agent-records', 30);
                return await publicAgentResponse(path[2], path[3] as 'context' | 'registration');
            }
            const onboarding = await handleOnboarding(request, key);
            if (onboarding)
                return onboarding;
            const actor = await requireUser(request);
            const identityResponse = await handleIdentity(request, key, actor);
            if (identityResponse)
                return identityResponse;
            const context = await handleContext(request, key);
            if (context)
                return context;
            if (key === 'state') {
                const snapshot = await state(actor);
                await requireRequestActor(request, actor);
                return ok(snapshot);
            }
            if (key === 'qualifications') {
                const conversations = await listQualificationDtos(actor.id);
                await requireRequestActor(request, actor);
                return ok(conversations);
            }
            if (key === 'auto-qualifications') {
                const batches = await listAutoQualifications(actor.id);
                await requireRequestActor(request, actor);
                return ok(batches);
            }
            if (path[0] === 'agent-tasks' && path.length === 2) {
                const task = await readAgentTask(actor.id, path[1]);
                await requireRequestActor(request, actor);
                return ok(task);
            }
            if (key === 'discovery/jobs')
                return ok(await discoveryJobs(actor.id));
            if (key === 'profile/intakes')
                return ok(await profileIntakes(actor.id));
            if (path[0] === 'proposals' && path[2] === 'meeting' && path.length === 3) {
                const p = await ownedProposal(actor.id, z.string().uuid().parse(path[1]));
                await validatePair(p, 'introduce');
                await requireUser(request);
                return ok(await meetingDto(actor.id, p.row.id));
            }
            if (key === 'agent/policies') {
                const current = await agent(actor.id);
                if (current)
                    await saveAgent(actor.id, current);
                return ok(await policyHistory(actor.id));
            }
            if (key === 'operations') {
                const rows = await db().prepare('SELECT * FROM operations WHERE user_id=? AND state IN (?,?) ORDER BY rowid DESC LIMIT 50').all(actor.id, 'prepared', 'submitted') as {
                    id: string;
                    kind: string;
                    state: string;
                    data: string;
                    created_at: string;
                }[];
                return ok(rows.map(x => ({ id: x.id, kind: x.kind, state: x.state, createdAt: x.created_at, data: decrypt(x.data, `operation:${x.id}`) })));
            }
            if (key === 'export') {
                await audit(actor.id, 'export', 'completed', 'Owner requested a private data export.');
                const snapshot = await state(actor);
                const messages = await db().prepare('SELECT messages.* FROM messages JOIN rooms ON rooms.id=messages.room_id JOIN proposals ON proposals.id=rooms.proposal_id WHERE proposals.left_user=? OR proposals.right_user=?').all(actor.id, actor.id) as {
                    id: string;
                    room_id: string;
                    body: string;
                    user_id: string;
                    created_at: string;
                }[];
                await requireRequestActor(request, actor);
                return ok({ ...snapshot, messages: messages.filter(x => x.user_id === actor.id).map(x => ({ id: x.id, roomId: x.room_id, body: decrypt<string>(x.body, `message:${x.id}`), createdAt: x.created_at })) });
            }
            if (path[0] === 'rooms' && path.length === 2) {
                const access = await roomAccess(actor.id, path[1]);
                const messages = await db().prepare('SELECT * FROM messages WHERE room_id=? ORDER BY created_at,rowid LIMIT 200').all(path[1]) as {
                    id: string;
                    user_id: string;
                    body: string;
                    created_at: string;
                }[];
                await requireRequestActor(request, actor);
                return ok({ room: access.room, messages: messages.map(x => ({ id: x.id, userId: x.user_id, body: decrypt<string>(x.body, `message:${x.id}`), createdAt: x.created_at })) });
            }
            throw new HttpError(404, 'NOT_FOUND', 'This endpoint was not found.');
        }
        if (request.method !== 'POST')
            throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
        checkOrigin(request);
        if (key === 'context/files') {
            const uploader = await requireUser(request);
            await rateLimit(`upload:${uploader.id}`, 10);
        }
        const body = await readBody(request, key === 'context/files' ? 1410000 : 64000);
        const walletAuth = await handleWalletAuth(request, key, body);
        if (walletAuth)
            return walletAuth;
        const onboarding = await handleOnboarding(request, key, body);
        if (onboarding)
            return onboarding;
        if (key === 'auth/register' || key === 'auth/login') {
            const input = z.object({ email: z.string().trim().email().max(254).transform(x => x.toLowerCase()), password: z.string().min(12).max(128) }).strict().parse(body);
            await rateLimit('auth:global', 60);
            await rateLimit('auth:' + hash(input.email), 10);
            if (key === 'auth/register') {
                return await atomic(async () => {
                    const id = randomUUID();
                    const p: Profile = { displayName: input.email.split('@')[0], headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
                    if (await db().prepare('SELECT id FROM users WHERE email=?').get(input.email))
                        throw new HttpError(409, 'ACCOUNT_EXISTS', 'This email is already registered. Sign in instead.');
                    await db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, input.email, hashPassword(input.password), null, encrypt(p, `profile:${id}`), new Date().toISOString());
                    await audit(id, 'account', 'created', 'Account created with private profile defaults.');
                    return ok({ id }, await createSession(id));
                });
            }
            const row = await db().prepare('SELECT * FROM users WHERE email=?').get(input.email) as UserRow | undefined;
            // A fixed valid salt keeps password work comparable for unknown accounts.
            const valid = verifyPassword(input.password, row?.password_hash || '00000000000000000000000000000000:' + '00'.repeat(64));
            if (!row || !valid)
                throw new HttpError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
            await audit(row.id, 'session', 'created', 'Signed in.');
            return ok({ id: row.id }, await createSession(row.id));
        }
        if (key === 'verifier') {
            const input = z.object({ ensName: z.string().max(253), owner: addressSchema, delegate: addressSchema, action: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), policyVersion: z.union([z.string().max(64), z.number().int()]).optional(), policyDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }).strict().parse(body);
            await rateLimit('verifier:public', 30);
            return ok(await verifyEnsIndependently({ rpcUrl: process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL }, input));
        }
        const actor = await requireUser(request);
        const checkSession = async () => {
            await requireRequestActor(request, actor);
        };
        await rateLimit(`api:${actor.id}`, 120);
        const identityResponse = await handleIdentity(request, key, actor, body);
        if (identityResponse)
            return identityResponse;
        const context = await handleContext(request, key, body);
        if (context)
            return context;
        const importedAgent = await handleAgentImport(request, key, body);
        if (importedAgent)
            return importedAgent;
        if (key === 'auth/logout') {
            const token = (await request.headers.get('cookie'))?.split(';').map(x => x.trim()).find(x => x.startsWith('meeti_session='))?.slice(14);
            if (token)
                await db().prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
            return ok({ signedOut: true }, 'meeti_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        }
        if (key === 'profile') {
            return await atomic(async () => {
                await checkSession();
                const input = profileSchema.parse(body);
                await db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(input, `profile:${actor.id}`), actor.id);
                await audit(actor.id, 'profile', 'saved', 'Profile and public visibility preferences updated.');
                return ok(input);
            });
        }
        if (key === 'wallet/challenge') {
            return await atomic(async () => {
                await checkSession();
                const input = z.object({ address: addressSchema }).strict().parse(body);
                await rateLimit('wallet:' + actor.id, 10);
                if (actor.wallet && actor.wallet.toLowerCase() !== input.address.toLowerCase())
                    throw new HttpError(409, 'WALLET_ROTATION_UNSUPPORTED', 'Wallet rotation is not supported in this MVP.');
                const id = randomUUID(), nonce = randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + 300000).toISOString();
                const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
                const message = `Meeti wallet ownership\nOrigin: ${origin}\nAccount: ${actor.id}\nAddress: ${input.address.toLowerCase()}\nChain ID: 11155111\nNonce: ${nonce}\nExpires: ${expiresAt}\nThis signature links your wallet. It does not authorize transactions.`;
                await db().prepare('INSERT INTO challenges VALUES(?,?,?,?,?,?,0)').run(id, actor.id, 'wallet', actor.id, encrypt({ message, address: input.address.toLowerCase() }, `challenge:${id}`), expiresAt);
                return ok({ id, message, chainId: 11155111 });
            });
        }
        if (key === 'wallet/verify') {
            const input = z.object({ id: z.string().uuid(), signature: hexSchema }).strict().parse(body);
            const row = await db().prepare('SELECT * FROM challenges WHERE id=? AND user_id=? AND kind=?').get(input.id, actor.id, 'wallet') as {
                data: string;
                used: number;
                expires_at: string;
            } | undefined;
            if (!row || row.used || Date.parse(row.expires_at) <= Date.now())
                throw new HttpError(403, 'CHALLENGE_EXPIRED', 'This wallet challenge is expired or already used.');
            const value = decrypt<{
                message: string;
                address: `0x${string}`;
            }>(row.data, `challenge:${input.id}`);
            if (!await verifyMessage({ address: value.address, message: value.message, signature: input.signature as `0x${string}` }))
                throw new HttpError(403, 'INVALID_SIGNATURE', 'Wallet ownership could not be verified.');
            await atomic(async () => {
                await checkSession();
                const currentWallet = (await db().prepare('SELECT wallet FROM users WHERE id=?').get(actor.id) as {
                    wallet: string | null;
                }).wallet;
                if (currentWallet && currentWallet.toLowerCase() !== value.address.toLowerCase())
                    throw new HttpError(409, 'WALLET_ROTATION_UNSUPPORTED', 'Wallet rotation is not supported in this MVP.');
                const changed = await db().prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires_at>?').run(input.id, new Date().toISOString());
                if (changed.changes !== 1)
                    throw new HttpError(403, 'REPLAY_DENIED', 'This wallet signature was already used.');
                if (await db().prepare('SELECT id FROM users WHERE lower(wallet)=? AND id<>?').get(value.address.toLowerCase(), actor.id))
                    throw new HttpError(409, 'WALLET_LINKED', 'This wallet is linked to another account.');
                await db().prepare('UPDATE users SET wallet=? WHERE id=?').run(value.address.toLowerCase(), actor.id);
                await audit(actor.id, 'wallet', 'verified', 'Wallet ownership verified by fresh signature.');
            });
            return ok({ wallet: value.address });
        }
        if (key === 'agent') {
            return await atomic(async () => {
                await checkSession();
                const input = agentSchema.parse(body);
                if (!actor.wallet)
                    throw new HttpError(409, 'WALLET_REQUIRED', 'Link your wallet before setting up agent authority.');
                if (actor.wallet.toLowerCase() === input.delegate.toLowerCase())
                    throw new HttpError(400, 'DISTINCT_DELEGATE_REQUIRED', 'Use a separate delegated agent address.');
                const existing = await agent(actor.id);
                const value: Agent = { id: existing?.id || randomUUID(), ensName: input.ensName, owner: actor.wallet, delegate: input.delegate, persona: input.persona,
                    policy: { ...input.policy, version: (existing?.policy.version || 0) + 1 }, authority: null,
                    config: { resolverAddress: input.resolverAddress || '', policyUri: input.policyUri || '' } };
                await saveAgent(actor.id, value);
                await audit(actor.id, 'policy', 'saved', `Policy revision ${value.policy.version}. Publish its digest to ENS before new agent actions.`);
                return ok({ ...value, policyDigest: policyDigest(value.policy) });
            });
        }
        if (key === 'agent/check') {
            const value = await authority(actor.id, 'discover');
            return ok(await agent(actor.id) || value);
        }
        if (key === 'agent/pause') {
            return await atomic(async () => {
                await checkSession();
                const { paused } = z.object({ paused: z.boolean() }).strict().parse(body);
                const value = requireValue(await agent(actor.id), 'Set up your agent.');
                const updated = { ...value, policy: { ...value.policy, paused, version: value.policy.version + 1 }, authority: null };
                await saveAgent(actor.id, updated);
                await audit(actor.id, 'agent', paused ? 'paused' : 'resumed', 'New protected actions require a current ENS policy digest.');
                return ok(updated);
            });
        }
        if (key === 'agent/transaction') {
            const input = z.object({ operation: z.enum(['deploy-registry', 'set-subregistry', 'create-subname', 'deploy-resolver', 'set-resolver', 'set-policy', 'grant', 'revoke', 'update-status']), value: z.string().max(2048).optional(), expiresAt: z.number().int().positive().optional(), maxFeeWei: z.string() }).strict().parse(body);
            parseEnsFeeCap(input.maxFeeWei);
            const value = requireValue(await agent(actor.id), 'Set up your agent.');
            let text = input.value;
            if (input.operation === 'set-policy') {
                text = JSON.stringify({ version: String(value.policy.version), ensName: value.ensName, owner: getAddress(value.owner), delegate: getAddress(value.delegate),
                    digest: policyDigest(value.policy), uri: value.config.policyUri || encodeInlinePolicyUri(value.policy), expiresAt: Math.floor(Date.parse(value.policy.expiresAt) / 1000), actions: [...value.policy.allowedActions, 'update-status'], resolverScope: 'dedicated-agent' });
            }
            if (input.operation === 'update-status' && !text?.trim()) {
                text = JSON.stringify({ schema: 'meeti.agent-card.v1', ensName: value.ensName, owner: value.owner,
                    delegate: value.delegate, persona: value.persona, capabilities: value.policy.allowedActions,
                    policyVersion: value.policy.version, policyDigest: policyDigest(value.policy) });
            }
            const transaction = await ensProvider(value).prepareTransaction({ operation: input.operation as EnsOperation, ensName: value.ensName, owner: value.owner, delegate: value.delegate, value: text, expiresAt: input.expiresAt });
            const quote = await quoteEnsTransactionFees(transaction, input.maxFeeWei);
            const reviewed = { ...transaction, gas: quote.gas, maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas, type: quote.type, ...(text ? { publicRecordPreview: { key: input.operation === 'set-policy' ? 'network.agent.policy' : 'network.agent.status', value: text } } : {}) };
            return await atomic(async () => {
                await checkSession();
                requireAgentSnapshot(value, requireValue(await agent(actor.id), 'Agent unavailable.'));
                const operationId = await saveOperation(actor.id, 'ens', { transaction: reviewed, policyDigest: policyDigest(value.policy), maxFeeWei: quote.maxFeeWei, expiresAt: quote.expiresAt });
                return ok({ operationId, transaction: reviewed, maxFeeWei: quote.maxFeeWei, expiresAt: quote.expiresAt, quotedMaximumFeeWei: quote.quotedMaximumFeeWei });
            });
        }
        if (key === 'agent/confirm') {
            const input = z.object({ operationId: z.string().uuid(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(body);
            const row = await operation(actor.id, input.operationId, 'ens');
            const value = requireValue(await agent(actor.id), 'Set up your agent.');
            const stored = decrypt<{
                transaction: {
                    from: `0x${string}`;
                    to: `0x${string}`;
                    data: `0x${string}`;
                    operation: string;
                    ensName: string;
                    predictedAddress?: string;
                };
                policyDigest: string;
                submittedHash?: string; maxFeeWei?: string; expiresAt?: string;
            }>(row.data, `operation:${row.id}`);
            if (stored.submittedHash && stored.submittedHash.toLowerCase() !== input.hash.toLowerCase())
                throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Confirm the transaction already recorded for this operation.');
            if (!stored.maxFeeWei || !stored.expiresAt) throw new HttpError(409, 'ENS_FEE_REVIEW_REQUIRED', 'This older preparation has no recorded fee cap. Its receipt needs a separate explicit review. Do not resend it. Cancel only if it was never submitted.');
            parseEnsFeeCap(stored.maxFeeWei);
            const result = await ensProvider(value).confirmTransaction({ hash: input.hash as `0x${string}`, expectedFrom: stored.transaction.from, expectedTo: stored.transaction.to, expectedData: stored.transaction.data });
            const actualFeeWei = await verifyEnsReceiptFee(input.hash as `0x${string}`, stored.maxFeeWei, result.blockNumber);
            return await atomic(async () => {
                await checkSession();
                const current = requireValue(await agent(actor.id), 'Agent unavailable.');
                requireAgentSnapshot(value, current);
                const currentOperation = await operation(actor.id, row.id, 'ens');
                const currentStored = decrypt<{
                    submittedHash?: string; maxFeeWei?: string; expiresAt?: string;
                    transaction?: unknown; policyDigest?: string;
                }>(currentOperation.data, `operation:${row.id}`);
                if (currentStored.submittedHash && currentStored.submittedHash.toLowerCase() !== input.hash.toLowerCase())
                    throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Confirm the transaction already recorded for this operation.');
                if (currentStored.maxFeeWei !== stored.maxFeeWei || currentStored.expiresAt !== stored.expiresAt) throw new HttpError(409, 'ENS_FEE_REVIEW_CHANGED', 'The saved fee review changed during confirmation.');
                if (hash(JSON.stringify(currentStored.transaction)) !== hash(JSON.stringify(stored.transaction)) || currentStored.policyDigest !== stored.policyDigest) throw new HttpError(409, 'OPERATION_CONFLICT', 'The immutable transaction review changed during confirmation.');
                if (!['prepared', 'submitted', 'confirmed'].includes(currentOperation.state))
                    throw new HttpError(409, 'OPERATION_CONFLICT', 'The operation changed during confirmation.');
                await db().prepare('UPDATE operations SET state=? WHERE id=?').run('confirmed', row.id);
                if (stored.transaction.operation === 'deploy-resolver' && stored.transaction.predictedAddress && stored.transaction.ensName === current.ensName)
                    await saveAgent(actor.id, { ...current, config: { ...current.config, resolverAddress: stored.transaction.predictedAddress } });
                await audit(actor.id, 'ens_transaction', 'confirmed', input.hash);
                return ok({ ...result, actualFeeWei, maxFeeWei: stored.maxFeeWei });
            });
        }
        if (key === 'intent/structure' || key === 'profile/structure') {
            const input = z.object({ text: z.string().min(1).max(8000), providerDisclosureConsent: z.literal(true) }).strict().parse(body);
            await rateLimit('ai:' + actor.id, 10, 3600000);
            if (key === 'intent/structure') {
                if (input.text.length > 1000)
                    throw new HttpError(400, 'INTENT_TOO_LONG', 'Use at most 1000 characters for the public intention.');
                const result = await interpretIntent(inferenceProvider(), input.text);
                await audit(actor.id, 'intent_interpretation', 'completed', result.inference.requestId);
                return ok({ ...result, output: { goal: result.output.category === 'unknown' ? 'collaborator' : result.output.category, summary: input.text.trim(),
                        tags: normalizeTopics(result.output.topics.map(x => x.value)).slice(0, 8), semantics: result.output } });
            }
            const result = await ai().structureOnboarding(input);
            result.output.tags = normalizeTopics(result.output.tags).slice(0, 8);
            await audit(actor.id, 'ai_structure', 'completed', result.inference.requestId);
            return ok(result);
        }
        if (key === 'profile/intake') {
            await rateLimit('intake:' + actor.id, 6, 3600000);
            return ok(await continueIntake(actor.id, body, async () => { await requireUser(request); }));
        }
        if (key === 'discovery/settings') {
            const input = z.object({ enabled: z.boolean(), providerDisclosureConsent: z.literal(true).optional() }).strict().parse(body);
            if (input.enabled && !input.providerDisclosureConsent)
                throw new HttpError(403, 'PROVIDER_CONSENT_REQUIRED', 'Approve provider processing for scheduled semantic discovery.');
            await setDiscoveryEnabled(actor.id, input.enabled);
            return ok(await discoveryJobs(actor.id));
        }
        if (key === 'intent') {
            const input = intentInputSchema.parse(body);
            return await atomic(async () => {
                const a = requireValue(await agent(actor.id), 'Set up your agent before creating a networking intent.');
                const pending = await db().prepare('SELECT kind FROM operations WHERE user_id=? AND state IN (?,?)').all(actor.id, 'prepared', 'submitted') as { kind: string }[];
                // A new private draft does not alter an ENS transaction or authorize publication.
                // Existing intent edits and pending publication snapshots retain their transaction guard.
                if (pending.some(operation => Boolean(input.id) || operation.kind !== 'ens'))
                    throw new HttpError(409, 'TRANSACTION_UNRESOLVED', 'Reconcile the pending transaction before editing an intent.');
                if (input.semantics)
                    assertIntentEvidence(input.summary, input.semantics);
                const previous = input.id ? await ownIntent(actor.id, input.id) : null;
                if (previous && input.expectedVersion !== previous.version)
                    throw new HttpError(409, 'INTENT_CHANGED', 'This intent changed or its reviewed revision is missing. Load and review the latest revision before saving.');
                if (!previous && input.expectedVersion !== undefined)
                    throw new HttpError(400, 'INVALID_INTENT_VERSION', 'Start a new intent without an existing revision.');
                const value: Intent = { id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1,
                    goal: input.goal, summary: input.summary, tags: input.tags, expiresAt: input.expiresAt, createdAt: new Date().toISOString(), policyVersion: a.policy.version,
                    status: 'draft', demoOrigin: input.demoOrigin, semantics: input.semantics };
                await saveIntent(actor.id, value);
                await queueDiscovery(actor.id, value);
                clearEmbeddingCache();
                await audit(actor.id, 'intent', 'draft_saved', `Intent ${value.id} version ${value.version}. Private draft reviewed. Publication requires separate authorization.`);
                return ok(value);
            });
        }
        if (key === 'intent/close') {
            const { intentId } = z.object({ intentId: z.string().uuid() }).strict().parse(body);
            const previous = await ownIntent(actor.id, intentId);
            assertIntent(previous);
            const a = await authority(actor.id, 'publish', previous.policyVersion);
            return await atomic(async () => {
                const currentActor = await requireUser(request);
                if (currentActor.id !== actor.id || currentActor.wallet?.toLowerCase() !== actor.wallet?.toLowerCase())
                    throw new HttpError(403, 'ACCOUNT_CHANGED', 'Sign in again before closing this intent.');
                const current = await ownIntent(actor.id, intentId);
                if (hash(JSON.stringify(current)) !== hash(JSON.stringify(previous)))
                    throw new HttpError(409, 'INTENT_CHANGED', 'This intent changed while checking permissions. Refresh before closing it.');
                assertIntent(current);
                const currentAgent = await agent(actor.id);
                if (!currentAgent || policyDigest(currentAgent.policy) !== policyDigest(a.policy))
                    throw new HttpError(409, 'POLICY_CHANGED', 'Agent permissions changed while closing this intent. Refresh and review them.');
                if (await db().prepare('SELECT id FROM operations WHERE user_id=? AND state IN (?,?)').get(actor.id, 'prepared', 'submitted'))
                    throw new HttpError(409, 'TRANSACTION_UNRESOLVED', 'Reconcile the pending transaction before closing this intent.');
                const value: Intent = { ...current, version: current.version + 1, createdAt: new Date().toISOString(), policyVersion: a.policy.version,
                    status: 'draft', publicStatus: 'closed', arkivKey: undefined, transactionHash: undefined };
                await saveIntent(actor.id, value);
                await queueDiscovery(actor.id, value);
                clearEmbeddingCache();
                await audit(actor.id, 'intent', 'closure_prepared', 'Local matching stopped. Publish the reviewed closure revision to update the public index.');
                return ok(value);
            });
        }
        if (key === 'intent/publish') {
            const input = z.object({ intentId: z.string().uuid(), signature: hexSchema.optional(), maxFeeWei: z.string().regex(/^\d+$/).max(30).optional() }).strict().parse(body);
            const value = await ownIntent(actor.id, input.intentId);
            if (Date.parse(value.expiresAt) <= Date.now() || value.status !== 'draft')
                throw new HttpError(409, 'INTENT_INACTIVE', 'Choose an active unpublished intent draft.');
            const a = await authority(actor.id, 'publish', value.policyVersion);
            const projection = publicIntent(value, a);
            if (!input.signature)
                return ok({ intent: projection, signingMessage: intentSigningMessage(projection) });
            const pending = await db().prepare('SELECT id FROM operations WHERE user_id=? AND state IN (?,?)').get(actor.id, 'prepared', 'submitted');
            if (pending)
                throw new HttpError(409, 'PUBLICATION_PENDING', 'A publication is already prepared. Reconcile it before requesting another signature.');
            const transaction = await arkiv().preparePublish({ intent: projection, signature: input.signature as `0x${string}`, maxFeeWei: requireValue(input.maxFeeWei, 'Provide a maximum transaction fee.') });
            await authority(actor.id, 'publish', value.policyVersion);
            return await atomic(async () => {
                await checkSession();
                const current = await ownIntent(actor.id, value.id);
                if (hash(JSON.stringify(current)) !== hash(JSON.stringify(value)))
                    throw new HttpError(409, 'INTENT_CHANGED', 'The intent changed during preparation.');
                requireAgentSnapshot(a, requireValue(await agent(actor.id), 'Agent unavailable.'));
                const operationId = await saveOperation(actor.id, 'arkiv:' + value.id + ':' + value.version, { transaction, intent: projection });
                return ok({ operationId, transaction });
            });
        }
        if (key === 'intent/confirm') {
            const input = z.object({ intentId: z.string().uuid(), operationId: z.string().uuid(), entityKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), autoQualification: z.object({ approved: z.literal(true), includeDemo: z.boolean() }).strict().optional() }).strict().parse(body);
            const value = await ownIntent(actor.id, input.intentId), a = requireValue(await agent(actor.id), 'Set up your agent.');
            const row = await operation(actor.id, input.operationId, 'arkiv:' + value.id + ':' + value.version);
            const stored = decrypt<{
                intent: ReturnType<typeof publicIntent>;
                transaction: {
                    request: Parameters<ReturnType<typeof arkiv>['verifyPublished']>[0]['expectedTransaction'];
                };
                submittedHash?: string;
            }>(row.data, `operation:${row.id}`);
            if (stored.submittedHash && stored.submittedHash.toLowerCase() !== input.txHash.toLowerCase())
                throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Confirm the transaction already recorded for this operation.');
            const confirmed = await arkiv().verifyPublished({ entityKey: input.entityKey, txHash: input.txHash, expectedIntent: stored.intent, expectedTransaction: stored.transaction.request });
            await authority(actor.id, 'publish', value.policyVersion);
            return await atomic(async () => {
                await checkSession();
                requireAgentSnapshot(a, requireValue(await agent(actor.id), 'Agent unavailable.'));
                if (hash(JSON.stringify(await ownIntent(actor.id, value.id))) !== hash(JSON.stringify(value)))
                    throw new HttpError(409, 'STATE_CHANGED', 'Intent or policy changed during confirmation.');
                const currentOperation = await operation(actor.id, row.id, 'arkiv:' + value.id + ':' + value.version);
                const currentStored = decrypt<{
                    submittedHash?: string;
                }>(currentOperation.data, `operation:${row.id}`);
                if (currentStored.submittedHash && currentStored.submittedHash.toLowerCase() !== input.txHash.toLowerCase())
                    throw new HttpError(409, 'TRANSACTION_MISMATCH', 'Confirm the transaction already recorded for this operation.');
                if (!['prepared', 'submitted', 'confirmed'].includes(currentOperation.state))
                    throw new HttpError(409, 'OPERATION_CONFLICT', 'The operation changed during confirmation.');
                await saveIntent(actor.id, { ...value, status: value.publicStatus === 'closed' ? 'revoked' : 'published', arkivKey: confirmed.entityKey, transactionHash: input.txHash });
                await db().prepare('UPDATE operations SET state=? WHERE id=?').run('confirmed', row.id);
                await audit(actor.id, 'arkiv_publish', 'confirmed', input.txHash);
                const published = await ownIntent(actor.id, value.id);
                await queueDiscovery(actor.id, published);
                const autoQualification = input.autoQualification && published.status === 'published'
                    ? await requestAutoQualification(actor.id, requireValue(sessionTokenHash(request), 'Sign in to continue.', 401), published, input.autoQualification) : undefined;
                return ok({ entityKey: confirmed.entityKey, transactionHash: input.txHash, autoQualification });
            });
        }
        if (path[0] === 'auto-qualifications' && path.length === 3 && path[2] === 'cancel') {
            z.object({}).strict().parse(body);
            await checkSession();
            return ok(await cancelAutoQualification(actor.id, z.string().uuid().parse(path[1])));
        }
        if (path[0] === 'operations' && path.length === 3) {
            return await atomic(async () => {
                await checkSession();
                const row = requireValue(await db().prepare('SELECT * FROM operations WHERE id=? AND user_id=?').get(path[1], actor.id) as {
                    id: string;
                    data: string;
                    state: string;
                } | undefined, 'Prepared operation was not found.', 404);
                const value = decrypt<Record<string, unknown>>(row.data, `operation:${row.id}`);
                if (path[2] === 'submitted') {
                    const { transactionHash } = z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(body);
                    if (!['prepared', 'submitted'].includes(row.state) || (value.submittedHash && value.submittedHash !== transactionHash))
                        throw new HttpError(409, 'OPERATION_CONFLICT', 'The operation already has a different result.');
                    await db().prepare('UPDATE operations SET state=?,data=? WHERE id=?').run('submitted', encrypt({ ...value, submittedHash: transactionHash }, `operation:${row.id}`), row.id);
                    await audit(actor.id, 'transaction', 'submitted', transactionHash);
                    return ok({ submitted: true });
                }
                if (path[2] === 'cancel') {
                    z.object({ confirmation: z.literal('NOT_SUBMITTED') }).strict().parse(body);
                    if (row.state !== 'prepared' || value.submittedHash)
                        throw new HttpError(409, 'RECONCILIATION_REQUIRED', 'A submitted transaction must be reconciled. It cannot be cancelled here.');
                    await db().prepare('UPDATE operations SET state=? WHERE id=?').run('cancelled', row.id);
                    await audit(actor.id, 'transaction', 'cancelled_before_submission', 'The owner confirmed that the wallet did not submit the prepared transaction.');
                    return ok({ cancelled: true });
                }
                throw new HttpError(404, 'NOT_FOUND', 'This operation endpoint was not found.');
            });
        }
        if (key === 'discover') {
            const input = z.object({ intentId: z.string().uuid(), goal: goalSchema.optional(), tags: tagsSchema.optional(), includeDemo: z.boolean().optional() }).strict().parse(body);
            await rateLimit('discover:' + actor.id, 12);
            const value = await ownIntent(actor.id, input.intentId);
            assertIntent(value);
            const result = await discoverCandidates(actor.id, value, input);
            await requireUser(request);
            assertIntent(await ownIntent(actor.id, value.id));
            await rememberDiscovery(actor.id, value, result);
            await audit(actor.id, 'discovery', 'semantic_ranked', `${result.candidates.length} Arkiv candidates ranked with bounded semantic coverage.`);
            return ok(result);
        }
        if (key === 'proposals') {
            const input = z.object({ intentId: z.string().uuid(), candidateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(body);
            if (process.env.AGENT_TASK_QUEUE_ENABLED === 'true') {
                const task = await enqueueAgentTask(actor.id, requireValue(sessionTokenHash(request), 'Sign in to continue.', 401), 'propose', input,
                    () => rateLimit('evaluate:' + actor.id, 4, 3600000));
                return Response.json({ data: task }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
            }
            await rateLimit('evaluate:' + actor.id, 4, 3600000);
            return ok(await withAgentRun(actor.id, progress => createProposal(actor.id, input.intentId, input.candidateKey, async () => { await requireUser(request); }, progress)));
        }
        if (path[0] === 'qualifications' && path.length === 3) {
            const id = z.string().uuid().parse(path[1]);
            if (process.env.AGENT_TASK_QUEUE_ENABLED === 'true' && (path[2] === 'resume' || path[2] === 'retry')) {
                const input = z.object({ version: z.number().int().positive() }).strict().parse(body);
                const task = await enqueueAgentTask(actor.id, requireValue(sessionTokenHash(request), 'Sign in to continue.', 401), path[2], { qualificationId: id, ...input },
                    () => rateLimit('evaluate:' + actor.id, 4, 3600000));
                return Response.json({ data: task }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
            }
            const checkSession = async () => {
                if ((await requireUser(request)).id !== actor.id)
                    throw new HttpError(403, 'ACCOUNT_CHANGED', 'Sign in again before continuing.');
            };
            if (path[2] === 'answer') {
                await rateLimit('qualification-answer:' + actor.id, 12);
                return ok(await answerQualification(actor.id, id, body, checkSession));
            }
            if (path[2] === 'cancel')
                return ok(await cancelQualification(actor.id, id, body, checkSession));
            if (path[2] === 'resume') {
                await rateLimit('evaluate:' + actor.id, 4, 3600000);
                return ok(await withAgentRun(actor.id, progress => resumeQualification(actor.id, id, body, checkSession, progress)));
            }
            if (path[2] === 'retry') {
                await rateLimit('evaluate:' + actor.id, 4, 3600000);
                return ok(await withAgentRun(actor.id, progress => retryQualification(actor.id, id, body, checkSession, progress)));
            }
        }
        if (path[0] === 'proposals' && path.length === 3) {
            const id = z.string().uuid().parse(path[1]);
            if (path[2] === 'meeting') {
                const input = z.object({ action: z.enum(['availability', 'select', 'confirm', 'finalize', 'cancel']), version: z.number().int().positive(),
                    availability: z.unknown().optional(), slot: z.object({ start: z.string(), end: z.string() }).strict().optional() }).strict().parse(body);
                await rateLimit('meeting:' + actor.id, 20);
                return ok(await meetingAction(actor.id, id, input, async () => { await requireUser(request); }));
            }
            if (path[2] === 'consent')
                return ok(await consent(actor.id, id, z.object({ decision: z.enum(['approve', 'decline', 'revoke']) }).strict().parse(body).decision, async () => {
                    const currentActor = await requireUser(request);
                    if (currentActor.id !== actor.id || currentActor.wallet?.toLowerCase() !== actor.wallet?.toLowerCase())
                        throw new HttpError(403, 'ACCOUNT_CHANGED', 'Sign in again before recording your decision.');
                }));
            if (path[2] === 'open')
                return ok(await openRoom(actor.id, id, async () => { await requireUser(request); }));
            if (path[2] === 'disclosure') {
                const { fieldId } = z.object({ fieldId: z.enum(['displayName', 'tags', 'headline', 'bio', 'seeking', 'offering', 'contact', 'employer', 'socialLinks', 'documentContext']) }).strict().parse(body);
                const p = await ownedProposal(actor.id, id);
                await validatePair(p, 'negotiate');
                const ownerId = p.row.left_user === actor.id ? p.row.right_user : p.row.left_user;
                const a = await authority(ownerId, 'negotiate');
                const ownerProfile = await profile(ownerId);
                const allowed = !['contact', 'employer'].includes(fieldId) && a.policy.allowedFields.includes(fieldId)
                    && (fieldId === 'documentContext' ? ownerProfile.aiConsent && Boolean(await approvedDocumentContext(ownerId))
                        : ownerProfile.publicFields.includes(fieldId) && (fieldId !== 'socialLinks' || ownerProfile.aiConsent));
                await audit(actor.id, 'disclosure_check', allowed ? 'allowed' : 'denied', `Field class: ${fieldId}. No field value returned.`);
                return ok({ allowed, reason: allowed ? 'This field is permitted by the current purpose-specific public disclosure policy.' : 'This field requires additional approval and protected release.' });
            }
        }
        if (path[0] === 'rooms' && path[2] === 'messages' && path.length === 3) {
            const input = z.object({ body: z.string().trim().min(1).max(4000), requestId: z.string().uuid().optional() }).strict().parse(body);
            await rateLimit('message:' + actor.id, 30);
            const access = await roomAccess(actor.id, path[1]);
            return await atomic(async () => {
                await checkSession();
                await assertPair(access.p);
                const id = input.requestId || randomUUID();
                const prior = await db().prepare('SELECT id,user_id,room_id FROM messages WHERE id=?').get(id) as {
                    id: string;
                    user_id: string;
                    room_id: string;
                } | undefined;
                if (prior && (prior.user_id !== actor.id || prior.room_id !== path[1]))
                    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This message identifier was already used.');
                if (!prior)
                    await db().prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id, path[1], actor.id, encrypt(input.body, `message:${id}`), new Date().toISOString());
                return ok({ id });
            });
        }
        if (key === 'blocks') {
            return await atomic(async () => {
                await checkSession();
                const { proposalId } = z.object({ proposalId: z.string().uuid() }).strict().parse(body);
                const p = await ownedProposal(actor.id, proposalId), target = p.row.left_user === actor.id ? p.row.right_user : p.row.left_user;
                await db().prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(actor.id, target);
                await db().prepare('UPDATE proposals SET status=? WHERE (left_user=? AND right_user=?) OR (left_user=? AND right_user=?)').run('blocked', actor.id, target, target, actor.id);
                await audit(actor.id, 'block', 'created', 'Blocked further introductions and room access with this account.');
                return ok({ blocked: true });
            });
        }
        if (key === 'world/challenge') {
            await rateLimit('world:start:' + actor.id, 8, 3600000);
            return ok(await startWorld(request, actor.id, body));
        }
        if (key === 'world/verify') {
            await rateLimit('world:poll:' + actor.id, 30);
            return ok(await pollWorld(request, actor.id, body));
        }
        if (key === 'world/cancel')
            return ok(await cancelWorld(actor.id, body));
        if (key === 'account/delete') {
            z.object({ confirmation: z.literal('DELETE') }).strict().parse(body);
            const checkDeletion = async () => {
                if ((await requireUser(request)).id !== actor.id)
                    throw new HttpError(403, 'ACCOUNT_CHANGED', 'Sign in again before deleting this account.');
                if (await db().prepare("SELECT id FROM operations WHERE user_id=? AND state IN ('storage_pending','storage_cleanup','storage_deleting')").get(actor.id)) {
                    throw new HttpError(409, 'PRIVATE_STORAGE_PENDING', 'Reconcile pending private file operations before deleting your account.');
                }
            };
            await checkDeletion();
            for (const document of await listDocuments(actor.id))
                await deleteStoredDocument(actor.id, document.id, document.version, async () => { await requireUser(request); });
            await atomic(async () => {
                await checkDeletion();
                if ((await listDocuments(actor.id)).length)
                    throw new HttpError(409, 'PRIVATE_STORAGE_PENDING', 'A private file changed during account deletion. Review and retry.');
                await db().prepare('UPDATE proposals SET status=? WHERE left_user=? OR right_user=?').run('revoked', actor.id, actor.id);
                await db().prepare('DELETE FROM users WHERE id=?').run(actor.id);
            });
            return ok({ deleted: true, publicDataNotice: 'Previously published ENS and Arkiv records can persist independently of this account.' }, 'meeti_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        }
        throw new HttpError(404, 'NOT_FOUND', 'This endpoint was not found.');
    }
    catch (error) {
        if (error instanceof z.ZodError)
            return Response.json({ error: { code: 'INVALID_INPUT', message: error.issues.map(x => `${x.path.join('.') || 'Request'}: ${x.message}`).join('; ').slice(0, 600) } }, { status: 400 });
        if (error instanceof HttpError)
            return Response.json({ error: { code: error.code, message: error.message } }, {
                status: error.status,
                headers: error.status === 429 && Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds! > 0
                    ? { 'Retry-After': String(error.retryAfterSeconds), 'Cache-Control': 'no-store' } : undefined,
            });
        if (error instanceof MatchingError)
            return Response.json({ error: { code: 'SEMANTIC_' + error.code.toUpperCase(), message: error.message } }, { status: 503 });
        if (error instanceof AgentError)
            return Response.json({ error: { code: `AI_${error.code.toUpperCase()}`, message: error.message } }, { status: error.code === 'configuration' ? 503 : 409 });
        return Response.json({ error: { code: 'OPERATION_UNAVAILABLE', message: 'This operation could not be completed. Check provider configuration and permission diagnostics before trying again. No success has been assumed.' } }, { status: 503 });
    }
}
