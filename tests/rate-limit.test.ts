import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { createSession, HttpError, rateLimit } from '../packages/server/security';
import { route } from '../packages/server/router';
import type { Profile } from '../packages/shared/src';
// These checks use actual SQLite limit buckets and local sessions. No provider or blockchain request is allowed.
const origin = 'http://127.0.0.1:3198', initialNow = Date.parse('2026-11-07T09:00:00.000Z');
let directory: string;
async function denied(action: () => void | Promise<void>) {
    try {
        await action();
    }
    catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        return error as HttpError & {
            retryAfterSeconds: number;
        };
    }
    throw new Error('Expected a rate-limit rejection.');
}
async function account() {
    const id = randomUUID(), wallet = `0x${randomBytes(20).toString('hex')}`;
    const profile: Profile = { displayName: 'Fictional rate fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', wallet, encrypt(profile, `profile:${id}`), new Date().toISOString());
    return { id, cookie: (await createSession(id)).split(';')[0] };
}
function post(owner: Awaited<ReturnType<typeof account>>, path: string, body: unknown) {
    return route(new Request(`${origin}/api/${path}`, { method: 'POST', headers: { origin, cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), path.split('/'));
}
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-rate-limit-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('APP_ORIGIN', origin);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(initialNow);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests are forbidden in local rate-limit tests.'));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe('rate limits report their actual remaining fixed window', () => {
    it('reports the full hour for a newly exhausted evaluation bucket instead of promising one minute', async () => {
        await rateLimit('evaluate:fixture', 1, 3600000);
        const error = await denied(async () => await rateLimit('evaluate:fixture', 1, 3600000));
        expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 3600 });
        expect(error.message).toMatch(/3600 seconds|60 minutes|1 hour/);
        expect(error.message).not.toMatch(/wait a minute/i);
    });
    it('reports a minute for the default window and rounds a partial remaining second upward', async () => {
        await rateLimit('default:fixture', 1);
        expect(await denied(async () => await rateLimit('default:fixture', 1))).toMatchObject({ retryAfterSeconds: 60 });
        vi.setSystemTime(initialNow + 1234);
        expect(await denied(async () => await rateLimit('default:fixture', 1))).toMatchObject({ retryAfterSeconds: 59 });
        vi.setSystemTime(initialNow + 59999);
        expect(await denied(async () => await rateLimit('default:fixture', 1))).toMatchObject({ retryAfterSeconds: 1 });
    });
    it('does not extend the fixed reset time when blocked requests arrive', async () => {
        await rateLimit('evaluate:fixture', 1, 3600000);
        vi.setSystemTime(initialNow + 120000);
        expect(await denied(async () => await rateLimit('evaluate:fixture', 1, 3600000))).toMatchObject({ retryAfterSeconds: 3480 });
        expect(db().prepare('SELECT reset_at FROM rate_limits WHERE bucket=?').get('evaluate:fixture')).toEqual({ reset_at: initialNow + 3600000 });
    });
    it.each([60000, 60001])('admits a new request at or after expiry (%sms) and starts a fresh window', async (elapsed) => {
        await rateLimit('expiry:fixture', 1);
        vi.setSystemTime(initialNow + elapsed);
        await expect(rateLimit('expiry:fixture', 1)).resolves.toBeUndefined();
        expect(db().prepare('SELECT count,reset_at FROM rate_limits WHERE bucket=?').get('expiry:fixture')).toEqual({ count: 1, reset_at: initialNow + elapsed + 60000 });
    });
    it('keeps another account bucket independent', async () => {
        await rateLimit('evaluate:first', 1, 3600000);
        await denied(async () => await rateLimit('evaluate:first', 1, 3600000));
        await expect(rateLimit('evaluate:second', 1, 3600000)).resolves.toBeUndefined();
    });
});
describe('rate-limit API responses expose a usable Retry-After header', () => {
    it('returns the remaining evaluation hour before any model or identity work', async () => {
        const owner = await account();
        db().prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(`evaluate:${owner.id}`, 4, initialNow + 3600000);
        vi.setSystemTime(initialNow + 2001);
        const response = await post(owner, 'proposals', { intentId: randomUUID(), candidateKey: `0x${'aa'.repeat(32)}` });
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('3598');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect((await response.json()).error.code).toBe('RATE_LIMITED');
        expect(db().prepare('SELECT id FROM qualifications').all()).toEqual([]);
        expect(db().prepare('SELECT id FROM agent_runs').all()).toEqual([]);
    });
    it('returns a minute limit for the ordinary authenticated request bucket', async () => {
        const owner = await account();
        db().prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(`api:${owner.id}`, 120, initialNow + 60000);
        const response = await post(owner, 'auth/logout', {});
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('60');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect((await response.json()).error.code).toBe('RATE_LIMITED');
        expect(db().prepare('SELECT token_hash FROM sessions').all()).toHaveLength(1);
    });
    it('does not add a retry header to an unrelated authentication error', async () => {
        const owner = await account();
        db().prepare('DELETE FROM sessions').run();
        const response = await post(owner, 'auth/logout', {});
        expect(response.status).toBe(401);
        expect(response.headers.get('Retry-After')).toBeNull();
    });
});
