import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db, saveAgent, saveIntent } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { discoveryJobs, discoveryTick, queueDiscovery, rememberDiscovery, setDiscoveryEnabled, type DiscoveryResult } from '../packages/server/discovery-jobs';
import type { Agent, Intent } from '../packages/shared/src';
let directory: string;
const result = { candidates: [], source: 'arkiv', mode: 'semantic', embeddingExecution: 'not-required-no-semantically-eligible-candidates', observedBlocks: [], coverage: { strategy: 'fixture', candidateLimit: 12, scannedCandidates: 0, unconfirmed: 0, exhaustive: false, truncated: false }, rejectedEntities: 0 } as DiscoveryResult;
function fixture() {
    const id = randomUUID(), now = new Date().toISOString();
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', null, encrypt({ displayName: 'Fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: true }, `profile:${id}`), now);
    const a: Agent = { id: randomUUID(), ensName: 'agent.fixture.eth', owner: `0x${'11'.repeat(20)}`, delegate: `0x${'22'.repeat(20)}`, persona: '', config: {}, authority: null,
        policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['discover'], paused: false, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
    saveAgent(id, a);
    const value: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Fixture is not a real networking result.', tags: [], expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: now, policyVersion: 1, status: 'published', demoOrigin: true, arkivKey: `0x${'aa'.repeat(32)}` };
    saveIntent(id, value);
    return { id, a, value };
}
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-discovery-jobs-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
});
afterEach(() => { closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
// The scheduler and SQLite leases are real. The injected retrieval function is a fixture, not live matching evidence.
describe('durable scheduled discovery boundaries', () => {
    it('requires opt-in and survives a database restart with a one-minute next run', async () => {
        const owner = fixture(), execute = vi.fn(async () => result);
        await queueDiscovery(owner.id, owner.value);
        await discoveryTick(execute);
        expect(execute).not.toHaveBeenCalled();
        await setDiscoveryEnabled(owner.id, true);
        closeDatabase();
        expect(await discoveryTick(execute)).toEqual({ processed: 1, failed: 0 });
        const job = (await discoveryJobs(owner.id)).jobs[0];
        expect(job).toMatchObject({ active: true, result });
        expect(Date.parse(job.nextRunAt!) - Date.now()).toBe(60000);
        expect((await discoveryJobs('unrelated')).jobs).toEqual([]);
    });
    it('prevents concurrent workers evaluating the same lease', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        let finish!: (value: DiscoveryResult) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const execute = vi.fn(() => new Promise<DiscoveryResult>(resolve => { finish = resolve; started(); }));
        const first = discoveryTick(execute);
        await ready;
        expect(await discoveryTick(execute)).toEqual({ processed: 0, failed: 0 });
        finish(result);
        await first;
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it('fences the first run after disable and re-enable, even with the same intent', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        let finish!: (value: DiscoveryResult) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const first = discoveryTick(() => new Promise<DiscoveryResult>(resolve => { finish = resolve; started(); }));
        await ready;
        await setDiscoveryEnabled(owner.id, false);
        await setDiscoveryEnabled(owner.id, true);
        finish(result);
        await first;
        expect((await discoveryJobs(owner.id)).jobs[0].result).toBeNull();
    });
    it('invalidates edited, closed, expired, or paused source results', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        await discoveryTick(async () => result);
        saveIntent(owner.id, { ...owner.value, version: 2 });
        expect((await discoveryJobs(owner.id)).jobs[0].result).toBeNull();
        await expect(rememberDiscovery(owner.id, owner.value, result)).rejects.toThrow();
        saveIntent(owner.id, owner.value);
        saveAgent(owner.id, { ...owner.a, policy: { ...owner.a.policy, paused: true } });
        expect((await discoveryJobs(owner.id)).jobs[0].active).toBe(false);
        saveAgent(owner.id, owner.a);
        saveIntent(owner.id, { ...owner.value, status: 'revoked' });
        expect((await discoveryJobs(owner.id)).jobs[0].result).toBeNull();
        saveIntent(owner.id, owner.value);
        vi.setSystemTime(new Date(Date.parse(owner.value.expiresAt) + 1));
        expect((await discoveryJobs(owner.id)).jobs[0].result).toBeNull();
    });
    it('clears saved candidates on provider failure without storing provider messages', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        await discoveryTick(async () => result);
        vi.setSystemTime(new Date(Date.now() + 60001));
        expect(await discoveryTick(async () => { throw new Error('private provider detail'); })).toEqual({ processed: 0, failed: 1 });
        expect((await discoveryJobs(owner.id)).jobs[0]).toMatchObject({ result: null, failureCode: 'PROVIDER_UNAVAILABLE' });
        expect(JSON.stringify(db().prepare('SELECT * FROM discovery_jobs').all())).not.toContain('private provider detail');
    });
    it('enforces account budgets across restarts without invoking the provider', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        db().prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(`scheduled-discovery:${owner.id}`, 60, Date.now() + 3600000);
        closeDatabase();
        const execute = vi.fn(async () => result);
        await discoveryTick(execute);
        expect(execute).not.toHaveBeenCalled();
        expect((await discoveryJobs(owner.id)).jobs[0].failureCode).toBe('ACCOUNT_DISCOVERY_LIMIT');
    });
    it('fences an expired worker when another worker completes the reclaimed lease', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        let finish!: (value: DiscoveryResult) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const first = discoveryTick(() => new Promise<DiscoveryResult>(resolve => { finish = resolve; started(); }));
        await ready;
        vi.setSystemTime(new Date(Date.now() + 5 * 60000 + 1));
        await discoveryTick(async () => ({ ...result, rejectedEntities: 7 }));
        finish(result);
        await first;
        expect((await discoveryJobs(owner.id)).jobs[0].result?.rejectedEntities).toBe(7);
    });
    it('rejects an in-flight result when owner provider consent is revoked', async () => {
        const owner = fixture();
        await setDiscoveryEnabled(owner.id, true);
        const running = discoveryTick(async () => {
            db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt({ displayName: 'Fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false }, `profile:${owner.id}`), owner.id);
            return result;
        });
        expect(await running).toEqual({ processed: 0, failed: 1 });
        expect((await discoveryJobs(owner.id)).jobs[0]).toMatchObject({ active: false, result: null });
    });
});
