import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile } from '../packages/shared/src';
import type { QualificationInput, QualificationResult } from '../packages/agents/src';
const external = vi.hoisted(() => ({ identity: vi.fn(), fresh: vi.fn(), authority: vi.fn(), read: vi.fn(), qualify: vi.fn() }));
vi.mock('../packages/server/identity', () => ({ resolveCurrentPublicAgentIdentityForUser: external.identity }));
vi.mock('../packages/server/discovery', () => ({ freshPublicIntent: external.fresh, assessPair: async () => ({ eligible: true }) }));
vi.mock('../packages/server/policy', async (original) => ({ ...await original<typeof import('../packages/server/policy')>(),
    authority: external.authority, arkiv: () => ({ readActive: external.read }), ai: () => ({ qualifyIntroduction: external.qualify }) }));
// This test-only capability substitution lets a negative file-grant test reach its identity guard.
// No World verification or protected release succeeds or is claimed by these fixtures.
vi.mock('../packages/server/capabilities', async (original) => ({ ...await original<typeof import('../packages/server/capabilities')>(), requireWorldCapability: () => { } }));
import { agent, closeDatabase, db, proposal, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { encrypt, hash } from '../packages/server/crypto';
import { createSession, HttpError } from '../packages/server/security';
import { startQualification } from '../packages/server/qualifications';
import { qualificationRecord } from '../packages/server/qualification-context';
import { consent, roomAccess, validatePair } from '../packages/server/proposals';
import { meetingAction } from '../packages/server/meetings';
import { createDocument, updateDocument } from '../packages/server/context-store';
import { handleContext } from '../packages/server/context';
import { privateSnapshotDigest } from '../packages/server/context-policy';
const origin = 'http://127.0.0.1:3198';
let directory: string;
async function owner(label: string, byte: string) {
    const id = randomUUID(), expiresAt = new Date(Date.now() + 3600000).toISOString(), now = new Date().toISOString();
    const profile: Profile = { displayName: label, bio: '', headline: '', seeking: '', offering: '', tags: [], publicFields: [], contact: 'PRIVATE CONTACT', employer: '', aiConsent: true };
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.test`, '', null, encrypt(profile, `profile:${id}`), now);
    const value: Agent = { id: randomUUID(), owner: `0x${byte.repeat(20)}`, delegate: `0x${'33'.repeat(20)}`, ensName: `agent.${label}.eth`, config: {}, persona: '', authority: null,
        policy: { version: 1, purpose: 'collaborator', allowedActions: ['negotiate', 'introduce', 'message'], allowedFields: ['documentContext'], expiresAt, paused: false } };
    saveAgent(id, value);
    const intent: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Fictional public collaboration intent', tags: [], expiresAt, createdAt: now, policyVersion: 1, status: 'published', demoOrigin: true, arkivKey: `0x${byte.repeat(32)}` };
    saveIntent(id, intent);
    return { id, value, intent, cookie: (await createSession(id)).split(';')[0] };
}
let left: Awaited<ReturnType<typeof owner>>, right: Awaited<ReturnType<typeof owner>>;
function identity(userId: string, registered = true) {
    const current = agent(userId)!;
    const tuple = { chainId: 11155111, registry: `0x${'44'.repeat(20)}`, agentId: userId === left.id ? '10' : '20' };
    return { ensName: current.ensName, owner: current.owner,
        context: registered ? { state: 'valid', value: { type: 'meeti-agent-context-v1', ensName: current.ensName, name: 'Fixture public agent', description: 'Approved public description', capabilities: [], endpoints: [], registration: tuple } } : { state: 'absent' },
        association: registered ? { state: 'verified', identity: tuple } : { state: 'absent' },
        observed: { chainId: 11155111, blockNumber: '1', checkedAt: new Date().toISOString() }, authorityVerified: false, humanVerified: false };
}
function qualified(input: QualificationInput): QualificationResult {
    const now = new Date().toISOString();
    return { schemaVersion: 1, id: randomUUID(), purpose: 'collaborator', state: 'qualified', stopReason: 'mutual_criteria_supported', round: 1, maxRounds: 3,
        participantBindings: [input.left, input.right].map(value => ({ agentId: value.agentId, intentId: value.intent.id, intentVersion: value.intent.version, goal: value.intent.goal })) as QualificationResult['participantBindings'],
        rubric: [], messages: [], ownerQuestions: [], answers: [], policyChecks: [], disclosureChecks: [], createdAt: now, updatedAt: now };
}
async function introduction() {
    const value = await startQualification(left.id, left.intent.id, right.intent.arkivKey!, () => { }, () => { });
    return { p: proposal(value.id!)!, qualificationId: value.qualificationId };
}
async function legacy(newFormat = false) {
    const id = randomUUID(), pairKey = randomUUID(), digest = hash(id);
    const value: ProposalData = { leftIntent: left.intent, rightIntent: right.intent, leftPolicy: left.value.policy, rightPolicy: right.value.policy,
        leftAgent: left.value.id, rightAgent: right.value.id, leftProfileDigest: await privateSnapshotDigest(left.id), rightProfileDigest: await privateSnapshotDigest(right.id),
        summary: 'Explicit historical test fixture', compatibility: newFormat ? { qualification: { state: 'qualified' } } : null, exchanges: [], createdAt: new Date().toISOString() };
    db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, pairKey, 'proposed', digest, encrypt(value, `proposal:${id}`));
    return proposal(id)!;
}
// Identity, AI and chain decisions are fixtures. SQL, encryption, tenancy, consent and action paths are real.
beforeEach(async () => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-proposal-identity-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('APP_ORIGIN', origin);
    Object.values(external).forEach(mock => mock.mockReset());
    left = await owner('left', '11');
    right = await owner('right', '22');
    external.identity.mockImplementation(async (id: string) => identity(id));
    external.fresh.mockResolvedValue({});
    external.authority.mockImplementation(async (id: string) => agent(id));
    external.read.mockResolvedValue({ owner: right.value.owner, intent: { intentId: right.intent.id, version: 1, ensAgentRef: right.value.ensName } });
    external.qualify.mockImplementation(async (input: QualificationInput) => qualified(input));
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe('post-proposal public identity boundaries with explicit provider fixtures', () => {
    it('accepts a linked qualified proposal only while both current identities match their reviewed bindings', async () => {
        const { p } = await introduction();
        await expect(validatePair(p, 'introduce')).resolves.toBeUndefined();
        await consent(left.id, p.row.id, 'approve', () => { });
        await consent(right.id, p.row.id, 'approve', () => { });
        expect(db().prepare('SELECT id FROM consents').all()).toHaveLength(2);
    });
    it.each(['removed', 'changed', 'wrong-tuple', 'revoked'])('denies %s identity after human approval without rewriting consent', async (mode) => {
        const { p } = await introduction();
        await consent(left.id, p.row.id, 'approve', () => { });
        await consent(right.id, p.row.id, 'approve', () => { });
        external.identity.mockImplementation(async (id: string) => {
            const value = identity(id, mode !== 'removed');
            if (id === right.id && mode === 'changed' && value.context.value)
                value.context.value.description = 'Changed public context';
            if (id === right.id && mode === 'wrong-tuple' && value.association.identity)
                value.association.identity.agentId = '999';
            if (id === right.id && mode === 'revoked')
                return { ...value, association: { state: 'invalid', reason: 'association_record_empty' } };
            return value;
        });
        await expect(validatePair(p, 'introduce')).rejects.toMatchObject({ code: mode === 'revoked' ? 'PUBLIC_IDENTITY_DENIED' : 'PUBLIC_IDENTITY_CHANGED' });
        expect(db().prepare('SELECT id FROM consents').all()).toHaveLength(2);
    });
    it('blocks meeting negotiation and room-message access when a registration changes after approval', async () => {
        const { p } = await introduction();
        await consent(left.id, p.row.id, 'approve', () => { });
        await consent(right.id, p.row.id, 'approve', () => { });
        const roomId = randomUUID();
        db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(roomId, p.row.id, encrypt({ id: roomId, proposalId: p.row.id, title: 'Fixture room', introduction: '', createdAt: new Date().toISOString() }, `room:${roomId}`));
        external.identity.mockImplementation(async (id: string) => {
            const value = identity(id);
            if (value.association.identity)
                value.association.identity.agentId = '999';
            return value;
        });
        await expect(meetingAction(left.id, p.row.id, { action: 'availability', version: 1, availability: { timezone: 'UTC', durationMinutes: 30, shareForThisMeeting: true,
                intervals: [{ start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString() }] } }, () => { })).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_CHANGED' });
        await expect(roomAccess(right.id, roomId)).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_CHANGED' });
        expect(db().prepare('SELECT proposal_id FROM meeting_plans').all()).toHaveLength(0);
    });
    it('does not create a private original grant for a stale public identity', async () => {
        const first = await createDocument(left.id, { name: 'fixture.txt', mimeType: 'text/plain', extractionStatus: 'ready', extractedText: 'PRIVATE FILE' }, Buffer.from('PRIVATE FILE'), () => { });
        const document = await updateDocument(left.id, first.id, { expectedVersion: first.version, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: true }, () => { });
        const { p } = await introduction();
        await consent(left.id, p.row.id, 'approve', () => { });
        await consent(right.id, p.row.id, 'approve', () => { });
        const roomId = randomUUID();
        db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(roomId, p.row.id, encrypt({ id: roomId, proposalId: p.row.id }, `room:${roomId}`));
        external.identity.mockImplementation(async (id: string) => identity(id, false));
        await expect(handleContext(new Request(`${origin}/api/context/files/${document.id}/share`, { method: 'POST', headers: { origin, cookie: left.cookie, 'content-type': 'application/json' } }), `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.row.id })).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_CHANGED' });
        expect(db().prepare('SELECT id FROM private_context_shares').all()).toHaveLength(0);
    });
    it.each(['missing', 'wrong-owners', 'wrong-proposal', 'not-qualified', 'snapshot-changed'])('denies a %s originating qualification', async (mode) => {
        const { p, qualificationId } = await introduction(), record = (await qualificationRecord(qualificationId))!;
        if (mode === 'missing')
            db().prepare('DELETE FROM qualifications WHERE id=?').run(qualificationId);
        else if (mode === 'wrong-owners')
            db().prepare('UPDATE qualifications SET left_user=?,right_user=? WHERE id=?').run(right.id, left.id, qualificationId);
        else {
            if (mode === 'wrong-proposal')
                record.value.proposalId = randomUUID();
            if (mode === 'not-qualified')
                record.value.result!.state = 'needs_owner';
            if (mode === 'snapshot-changed')
                record.value.snapshot.summary = 'Changed fixture';
            db().prepare('UPDATE qualifications SET data=? WHERE id=?').run(encrypt(record.value, `qualification:${qualificationId}`), qualificationId);
        }
        await expect(validatePair(p, 'message')).rejects.toMatchObject({ code: mode === 'missing' ? 'QUALIFICATION_REQUIRED' : 'QUALIFICATION_BINDING_CHANGED' });
    });
    it('preserves legacy ENS-authorized absence but denies a newly declared identity without historical binding', async () => {
        const p = await legacy();
        external.identity.mockImplementation(async (id: string) => identity(id, false));
        await expect(validatePair(p, 'message')).resolves.toBeUndefined();
        external.identity.mockImplementation(async (id: string) => identity(id));
        await expect(validatePair(p, 'message')).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_BINDING_REQUIRED' });
    });
    it('rejects a fabricated new-format proposal without a qualified record even if current metadata is absent', async () => {
        const p = await legacy(true);
        external.identity.mockImplementation(async (id: string) => identity(id, false));
        await expect(validatePair(p, 'message')).rejects.toMatchObject({ code: 'QUALIFICATION_REQUIRED' });
    });
    it('propagates current resolver and authorization failure without downgrading to legacy absence', async () => {
        const { p } = await introduction();
        external.identity.mockRejectedValue(new HttpError(503, 'PUBLIC_IDENTITY_UNAVAILABLE', 'Fixture resolver unavailable.'));
        await expect(validatePair(p, 'message')).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_UNAVAILABLE' });
        external.identity.mockImplementation(async (id: string) => identity(id));
        external.fresh.mockRejectedValue(new HttpError(403, 'ENS_DENIED', 'Fixture permission revoked.'));
        await expect(validatePair(p, 'message')).rejects.toMatchObject({ code: 'ENS_DENIED' });
    });
});
