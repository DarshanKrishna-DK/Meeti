import { randomUUID } from 'node:crypto';
import { agent, atomic, db, intent, profile, type IntentRow } from './store';
import { decrypt, encrypt, hash } from './crypto';
import { discoverCandidates } from './discovery';
import { policyDigest } from './policy';
import type { Intent } from '../shared/src';
import { HttpError } from './security';
type Job = {
    intent_id: string;
    user_id: string;
    binding: string;
    enabled: number;
    next_run_at: string;
    lease_token: string | null;
    lease_until: string | null;
    result: string | null;
    checked_at: string | null;
    failure_code: string | null;
    failures: number;
};
export type DiscoveryResult = Awaited<ReturnType<typeof discoverCandidates>>;
const cadenceMs = 60000, leaseMs = 5 * 60000;
export async function discoveryEnabled(userId: string): Promise<boolean> {
    return Boolean((await db().prepare('SELECT enabled FROM discovery_preferences WHERE user_id=?').get(userId) as {
        enabled: number;
    } | undefined)?.enabled);
}
async function binding(userId: string, value: Intent): Promise<string> {
    const a = await agent(userId);
    return hash(JSON.stringify({ id: value.id, version: value.version, key: value.arkivKey, status: value.status, expiry: value.expiresAt,
        semanticConfiguration: [process.env.EMBEDDING_PROTOCOL, process.env.EMBEDDING_MODEL, process.env.EMBEDDING_MODEL_REVISION,
            process.env.EMBEDDING_DIMENSIONS, process.env.MATCHING_MIN_COSINE, process.env.MATCHING_CALIBRATED_REVISION, process.env.MATCHING_CALIBRATED_FORMAT],
        agent: a ? { id: a.id, owner: a.owner, delegate: a.delegate, name: a.ensName, resolver: a.config.resolverAddress, policy: policyDigest(a.policy) } : null }));
}
async function locallyEligible(userId: string, value: Intent): Promise<boolean> {
    const a = await agent(userId);
    return value.status === 'published' && Boolean(value.arkivKey) && Date.parse(value.expiresAt) > Date.now()
        && Boolean(a && value.policyVersion === a.policy.version && !a.policy.paused && a.policy.allowedActions.includes('discover') && Date.parse(a.policy.expiresAt) > Date.now() && (await profile(userId)).aiConsent);
}
export async function queueDiscovery(userId: string, value: Intent): Promise<void> {
    const enabled = await discoveryEnabled(userId) && await locallyEligible(userId, value);
    const current = await binding(userId, value), now = new Date().toISOString();
    await db().prepare(`INSERT INTO discovery_jobs(intent_id,user_id,binding,enabled,next_run_at) VALUES(?,?,?,?,?)
    ON CONFLICT(intent_id) DO UPDATE SET binding=excluded.binding,enabled=excluded.enabled,next_run_at=excluded.next_run_at,
    result=CASE WHEN discovery_jobs.binding=excluded.binding THEN discovery_jobs.result ELSE NULL END,
    checked_at=CASE WHEN discovery_jobs.binding=excluded.binding THEN discovery_jobs.checked_at ELSE NULL END,
    lease_token=CASE WHEN discovery_jobs.binding=excluded.binding AND discovery_jobs.enabled=excluded.enabled THEN discovery_jobs.lease_token ELSE NULL END,
    lease_until=CASE WHEN discovery_jobs.binding=excluded.binding AND discovery_jobs.enabled=excluded.enabled THEN discovery_jobs.lease_until ELSE NULL END`).run(value.id, userId, current, enabled ? 1 : 0, now);
}
export async function setDiscoveryEnabled(userId: string, enabled: boolean): Promise<void> {
    if (enabled && !(await profile(userId)).aiConsent)
        throw new HttpError(403, 'AI_CONSENT_REQUIRED', 'Allow provider processing before enabling scheduled semantic discovery.');
    await atomic(async () => {
        await db().prepare('INSERT INTO discovery_preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(userId, enabled ? 1 : 0);
        const rows = await db().prepare('SELECT * FROM intents WHERE user_id=?').all(userId) as IntentRow[];
        for (const row of rows)
            await queueDiscovery(userId, decrypt<Intent>(row.data, `intent:${row.id}`));
    });
}
export async function discoveryJobs(userId: string) {
    const rows = await db().prepare('SELECT * FROM discovery_jobs WHERE user_id=? ORDER BY next_run_at LIMIT 30').all(userId) as Job[];
    return { enabled: await discoveryEnabled(userId), cadenceSeconds: 60, hostRequirement: 'Run npm run worker:discovery on a persistent Node host. A browser tab is not the scheduler.',
        jobs: (await Promise.all(rows.map(async (row) => {
            const current = await intent(row.intent_id);
            if (!current || current.userId !== userId)
                return [];
            const valid = await binding(userId, current.value) === row.binding && await locallyEligible(userId, current.value);
            const saved = valid && row.result ? decrypt<DiscoveryResult>(row.result, `discovery:${row.intent_id}:${row.binding}`) : null;
            const result = saved ? { ...saved, candidates: saved.candidates.filter(candidate => Date.parse(candidate.expiresAt) > Date.now()) } : null;
            return [{ intentId: row.intent_id, active: Boolean(row.enabled && valid), checkedAt: valid ? row.checked_at : null,
                    nextRunAt: row.enabled && valid ? row.next_run_at : null, running: valid && Boolean(row.lease_until && Date.parse(row.lease_until) > Date.now()),
                    failureCode: row.failure_code, result }];
        }))).flat() };
}
export async function rememberDiscovery(userId: string, value: Intent, result: DiscoveryResult): Promise<void> {
    const expected = await binding(userId, value), current = await intent(value.id);
    if (!current || current.userId !== userId || await binding(userId, current.value) !== expected)
        throw new HttpError(409, 'INTENT_CHANGED', 'The intent changed during discovery.');
    await queueDiscovery(userId, value);
    await db().prepare('UPDATE discovery_jobs SET result=?,checked_at=?,next_run_at=?,failure_code=NULL,failures=0 WHERE intent_id=? AND binding=?')
        .run(encrypt(result, `discovery:${value.id}:${expected}`), new Date().toISOString(), new Date(Date.now() + cadenceMs).toISOString(), value.id, expected);
}
/** Serialized transactions and a persisted fencing token prevent duplicate workers committing expired work. */
export async function discoveryTick(execute = discoverCandidates): Promise<{
    processed: number;
    failed: number;
}> {
    let processed = 0, failed = 0;
    const attempted = new Set<string>();
    // Two intents per tick bounds RPC and inference work; overdue coverage is visible in nextRunAt.
    for (let index = 0; index < 2; index++) {
        const token = randomUUID(), now = new Date().toISOString();
        const job = await atomic(async () => {
            const rows = await db().prepare('SELECT * FROM discovery_jobs WHERE enabled=1 AND next_run_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_run_at,intent_id LIMIT 3').all(now, now) as Job[];
            const row = rows.find(candidate => !attempted.has(candidate.intent_id));
            if (!row)
                return null;
            attempted.add(row.intent_id);
            // Attempts, including failures, consume a durable account budget across worker restarts.
            const bucket = `scheduled-discovery:${row.user_id}`;
            const budget = await db().prepare('SELECT count,reset_at FROM rate_limits WHERE bucket=?').get(bucket) as {
                count: number;
                reset_at: number;
            } | undefined;
            if (budget && budget.reset_at > Date.now() && budget.count >= 60) {
                await db().prepare('UPDATE discovery_jobs SET next_run_at=?,failure_code=? WHERE intent_id=?').run(new Date(budget.reset_at).toISOString(), 'ACCOUNT_DISCOVERY_LIMIT', row.intent_id);
                return null;
            }
            await db().prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END')
                .run(bucket, Date.now() + 3600000, Date.now(), Date.now());
            await db().prepare('UPDATE discovery_jobs SET lease_token=?,lease_until=? WHERE intent_id=?').run(token, new Date(Date.now() + leaseMs).toISOString(), row.intent_id);
            return row;
        });
        if (!job)
            break;
        try {
            const current = await intent(job.intent_id);
            if (!current || current.userId !== job.user_id || !await discoveryEnabled(job.user_id) || !await locallyEligible(job.user_id, current.value) || await binding(job.user_id, current.value) !== job.binding) {
                await db().prepare('UPDATE discovery_jobs SET enabled=0,result=NULL,lease_token=NULL,lease_until=NULL WHERE intent_id=? AND lease_token=?').run(job.intent_id, token);
                continue;
            }
            const result = await execute(job.user_id, current.value, {});
            await atomic(async () => {
                const fresh = await intent(job.intent_id);
                if (!fresh || !await discoveryEnabled(job.user_id) || !await locallyEligible(job.user_id, fresh.value) || await binding(job.user_id, fresh.value) !== job.binding)
                    throw new HttpError(409, 'DISCOVERY_CHANGED', 'The intent or permissions changed during scheduled discovery.');
                const updated = await db().prepare('UPDATE discovery_jobs SET result=?,checked_at=?,next_run_at=?,lease_token=NULL,lease_until=NULL,failure_code=NULL,failures=0 WHERE intent_id=? AND binding=? AND lease_token=? AND lease_until>?')
                    .run(encrypt(result, `discovery:${job.intent_id}:${job.binding}`), new Date().toISOString(), new Date(Date.now() + cadenceMs).toISOString(), job.intent_id, job.binding, token, new Date().toISOString());
                if (updated.changes !== 1)
                    throw new HttpError(409, 'DISCOVERY_LEASE_LOST', 'Scheduled discovery lost its lease.');
            });
            processed++;
        }
        catch (error) {
            // Never persist provider bodies, prompts, credentials or arbitrary remote exception messages.
            const code = error instanceof HttpError ? error.code : 'PROVIDER_UNAVAILABLE';
            await db().prepare('UPDATE discovery_jobs SET result=NULL,failure_code=?,failures=failures+1,next_run_at=?,lease_token=NULL,lease_until=NULL WHERE intent_id=? AND lease_token=?')
                .run(code, new Date(Date.now() + Math.min(15 * cadenceMs, cadenceMs * 2 ** Math.min(job.failures, 4))).toISOString(), job.intent_id, token);
            failed++;
        }
    }
    return { processed, failed };
}
