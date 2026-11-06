import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Agent, Intent } from '../packages/shared/src';
// External decisions are fixtures. The route, sessions, lease, transaction and persistence are real.
const providers = vi.hoisted(() => ({ authority: vi.fn(), readActive: vi.fn(), evaluate: vi.fn(), negotiate: vi.fn(), assess: vi.fn(), fresh: vi.fn(), identity: vi.fn() }));
vi.mock('../packages/server/identity', async (importOriginal) => ({
    ...await importOriginal<typeof import('../packages/server/identity')>(),
    resolveCurrentPublicAgentIdentityForUser: providers.identity,
}));
vi.mock('../packages/server/policy', async (importOriginal) => ({
    ...await importOriginal<typeof import('../packages/server/policy')>(),
    authority: providers.authority,
    arkiv: () => ({ readActive: providers.readActive }),
    ai: () => ({ qualifyIntroduction: providers.negotiate }),
}));
vi.mock('../packages/server/discovery', async (importOriginal) => ({
    ...await importOriginal<typeof import('../packages/server/discovery')>(),
    assessPair: providers.assess,
    freshPublicIntent: providers.fresh,
}));
import { route } from '../packages/server/router';
import { agentRuns } from '../packages/server/agent-runs';
import { agent, closeDatabase, db, proposal, saveAgent, saveIntent } from '../packages/server/db';
const origin = 'http://127.0.0.1:3198';
let directory: string;
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}
async function call(path: string, body?: unknown, cookie?: string) {
    return route(new Request(`${origin}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), path.split('/'));
}
async function ownerFixture(label: string) {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const challenge = await call('auth/wallet/challenge', { address: wallet.address, chainId: 11155111 });
    expect(challenge.status).toBe(200);
    const { data } = await challenge.json();
    const flow = challenge.headers.getSetCookie().find(value => value.startsWith('meeti_wallet_flow='))!.split(';')[0];
    const signed = await call('auth/wallet/verify', { id: data.id, signature: await wallet.signMessage({ message: data.message }) }, flow);
    expect(signed.status).toBe(200);
    const account = (await signed.json()).data as {
        id: string;
    };
    const cookie = signed.headers.getSetCookie().find(value => value.startsWith('meeti_session='))!.split(';')[0];
    const value: Agent = { id: randomUUID(), ensName: `agent.${label}-boundary-fixture.eth`, owner: wallet.address, delegate: `0x${'22'.repeat(20)}`, persona: '', config: {}, authority: null,
        policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['negotiate'], expiresAt: new Date(Date.now() + 7200000).toISOString(), paused: false } };
    saveAgent(account.id, value);
    const intent: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Explicit local proposal boundary fixture', tags: [],
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7200000).toISOString(), policyVersion: 1, status: 'published', demoOrigin: true,
        arkivKey: `0x${(label === 'left' ? 'aa' : 'bb').repeat(32)}` };
    saveIntent(account.id, intent);
    return { id: account.id, cookie, agent: value, intent };
}
async function pendingProposal() {
    const left = await ownerFixture('left'), right = await ownerFixture('right');
    const gate = deferred();
    providers.readActive.mockResolvedValue({ owner: right.agent.owner, intent: { intentId: right.intent.id, version: right.intent.version, ensAgentRef: right.agent.ensName } });
    let reads = 0;
    providers.fresh.mockImplementation(async () => { if (++reads > 2)
        await gate.promise; return {}; });
    const response = call('proposals', { intentId: left.intent.id, candidateKey: right.intent.arkivKey }, left.cookie);
    await vi.waitFor(() => expect(providers.fresh).toHaveBeenCalledTimes(4));
    expect((await agentRuns(left.id))[0]).toMatchObject({ status: 'running', stage: 'rechecking_permissions' });
    return { left, right, gate, response };
}
function expectNoProposal() {
    expect(db().prepare('SELECT id FROM proposals').all()).toEqual([]);
    expect(db().prepare("SELECT id FROM audit WHERE action='proposal'").all()).toEqual([]);
}
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-proposal-boundary-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('APP_ORIGIN', origin);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    for (const mock of Object.values(providers))
        mock.mockReset();
    providers.authority.mockImplementation(async (userId: string) => agent(userId));
    providers.identity.mockImplementation(async (userId: string) => ({
        ensName: agent(userId)!.ensName, owner: agent(userId)!.owner,
        context: { state: 'absent' }, association: { state: 'absent' },
        observed: { chainId: 11155111, blockNumber: '1', checkedAt: new Date().toISOString() },
        authorityVerified: false, humanVerified: false,
    }));
    providers.assess.mockResolvedValue({ eligible: true });
    providers.evaluate.mockResolvedValue({ output: { assessment: 'aligned', summary: 'Explicit local compatibility fixture' } });
    providers.negotiate.mockResolvedValue({ state: 'qualified', messages: [], ownerQuestions: [], answers: [], stopReason: 'mutual_criteria_supported' });
});
afterEach(() => {
    closeDatabase();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
});
describe('proposal persistence after delayed final permission checks', () => {
    it.each([false, true])('does not persist expired work when the interrupted row was observed: %s', async (observeExpiry) => {
        const pending = await pendingProposal();
        vi.setSystemTime(new Date(Date.parse((await agentRuns(pending.left.id))[0].expiresAt) + 1));
        if (observeExpiry) {
            const response = await call('state', undefined, pending.left.cookie);
            expect(response.status).toBe(200);
            expect((await response.json()).data.agentRuns[0]).toMatchObject({ status: 'interrupted' });
        }
        pending.gate.resolve();
        const response = await pending.response;
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('AGENT_RUN_INTERRUPTED');
        expectNoProposal();
        expect((await agentRuns(pending.left.id))[0]).toMatchObject({ status: 'interrupted', stage: 'interrupted' });
        expect(db().prepare("SELECT id FROM audit WHERE action='agent_run' AND outcome='completed'").all()).toEqual([]);
    });
    it('does not persist a proposal after logout during the final permission check', async () => {
        const pending = await pendingProposal();
        expect((await call('auth/logout', {}, pending.left.cookie)).status).toBe(200);
        pending.gate.resolve();
        const response = await pending.response;
        expect(response.status).toBe(401);
        expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED');
        expectNoProposal();
        expect((await agentRuns(pending.left.id))[0]).toMatchObject({ status: 'failed' });
    });
    it('commits one proposal and its completed run while the session and lease remain valid', async () => {
        const pending = await pendingProposal();
        vi.setSystemTime(new Date(Date.parse((await agentRuns(pending.left.id))[0].expiresAt) - 1));
        pending.gate.resolve();
        const response = await pending.response;
        const payload = await response.json() as {
            data: {
                id: string;
            };
        };
        expect(response.status, JSON.stringify(payload)).toBe(200);
        const { data } = payload;
        expect(proposal(data.id)?.row).toMatchObject({ left_user: pending.left.id, right_user: pending.right.id, status: 'proposed' });
        expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(1);
        expect((await agentRuns(pending.left.id))[0]).toMatchObject({ status: 'completed', stage: 'completed', proposalId: data.id });
        expect(db().prepare("SELECT id FROM audit WHERE action='proposal'").all()).toHaveLength(2);
    });
});
