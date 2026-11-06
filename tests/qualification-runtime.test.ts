import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile } from '../packages/shared/src';
import type { QualificationInput, QualificationResult } from '../packages/agents/src';
const external = vi.hoisted(() => ({ qualify: vi.fn(), read: vi.fn(), fresh: vi.fn(), assess: vi.fn(), authority: vi.fn() }));
vi.mock('../packages/server/policy', async original => ({ ...await original<typeof import('../packages/server/policy')>(), ai: () => ({ qualifyIntroduction: external.qualify }), arkiv: () => ({ readActive: external.read }), authority: external.authority }));
vi.mock('../packages/server/discovery', () => ({ freshPublicIntent: external.fresh, assessPair: external.assess }));
import { closeDatabase, db, saveAgent, saveIntent, agent } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { startQualification, listQualificationDtos, answerQualification, resumeQualification, cancelQualification } from '../packages/server/qualifications';
import { qualificationAnswerAllowed, qualificationRecord } from '../packages/server/qualification-context';

// Provider and chain decisions are fixtures. SQL transactions, leases, encryption and tenant checks are real.
let directory: string;
function fixture(name: string) {
  const id = randomUUID(), now = new Date().toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString();
  const p: Profile = { displayName: name, bio: '', headline: '', offering: '', seeking: '', tags: [], contact: 'PRIVATE CONTACT', employer: '', publicFields: [], aiConsent: true };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.test`, '', null, encrypt(p, `profile:${id}`), now);
  const a: Agent = { id: randomUUID(), ensName: `agent.${name}.eth`, owner: `0x${(name === 'left' ? '11' : '22').repeat(20)}`, delegate: `0x${'33'.repeat(20)}`, persona: '', config: {}, authority: null,
    policy: { version: 1, purpose: 'collaborator', allowedFields: ['bio', 'seeking'], allowedActions: ['negotiate'], expiresAt, paused: false } };
  saveAgent(id, a);
  const value: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Approved public networking intent', tags: [], expiresAt, createdAt: now, policyVersion: 1, status: 'published', demoOrigin: true, arkivKey: `0x${(name === 'left' ? 'aa' : 'bb').repeat(32)}` };
  saveIntent(id, value); return { id, a, intent: value };
}
let left: ReturnType<typeof fixture>, right: ReturnType<typeof fixture>;
function result(input: QualificationInput, state: QualificationResult['state'] = 'needs_owner'): QualificationResult {
  const timestamp = new Date().toISOString();
  return { schemaVersion: 1, id: randomUUID(), purpose: 'collaborator', state, stopReason: state === 'qualified' ? 'mutual_criteria_supported' : 'owner_information_required', round: 1, maxRounds: 3,
    participantBindings: [input.left, input.right].map(p => ({ agentId: p.agentId, intentId: p.intent.id, intentVersion: p.intent.version, goal: p.intent.goal })) as QualificationResult['participantBindings'],
    rubric: [], messages: [input.left, input.right].map(p => ({ schemaVersion: 1, id: randomUUID(), agentId: p.agentId, round: 1, createdAt: timestamp, projectionDigest: 'a'.repeat(64), message: `Fixture approved exchange ${p.agentId}`, findings: [], peerQuestions: [], requestedFieldIds: [], evidence: [], inference: { requestId: randomUUID(), providerRequestId: null, model: 'fixture', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, startedAt: timestamp, completedAt: timestamp } })),
    ownerQuestions: state === 'needs_owner' ? [{ id: randomUUID(), ownerAgentId: input.left.agentId, askedByAgentId: input.right.agentId, question: 'What contribution do you explicitly offer?', criterionIds: [], evidence: [], round: 1, createdAt: timestamp }] : [], answers: [], policyChecks: [], disclosureChecks: [], createdAt: timestamp, updatedAt: timestamp };
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-qualification-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  Object.values(external).forEach(mock => mock.mockReset()); left = fixture('left'); right = fixture('right');
  external.authority.mockImplementation(async (id: string) => agent(id));
  external.read.mockResolvedValue({ owner: right.a.owner, intent: { intentId: right.intent.id, version: 1, ensAgentRef: right.a.ensName } });
  external.fresh.mockResolvedValue({}); external.assess.mockResolvedValue({ eligible: true });
  external.qualify.mockImplementation(async input => result(input));
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const start = () => startQualification(left.id, left.intent.id, right.intent.arkivKey!, () => {}, () => {});
describe('persisted qualification boundaries with fixture providers', () => {
  it('keeps owner questions private to their addressee and does not propose from missing information', async () => {
    await start(); expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(0);
    expect(listQualificationDtos(left.id)[0].questions).toHaveLength(1); expect(listQualificationDtos(right.id)[0].questions).toHaveLength(0);
    expect(listQualificationDtos('foreign')).toEqual([]); expect(JSON.stringify(listQualificationDtos(right.id))).not.toContain('PRIVATE CONTACT');
  });
  it('creates one proposal only after qualification and deduplicates repeat requests', async () => {
    external.qualify.mockImplementation(async input => result(input, 'qualified'));
    const first = await start(), second = await start(); expect(first.id).toBeTruthy(); expect(second).toEqual(first);
    expect(external.qualify).toHaveBeenCalledTimes(1); expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(1);
  });
  it('persists a completed turn when a subsequent provider call fails without fabricated success', async () => {
    external.qualify.mockImplementation(async (input: QualificationInput) => {
      const value = result(input); await input.onProgress!({ kind: 'turn_completed', qualificationId: value.id, schemaVersion: 1, round: 1, maxRounds: 3, participantBindings: value.participantBindings, message: value.messages[0], ownerQuestions: value.ownerQuestions, policyChecks: [] });
      throw new Error('REMOTE PRIVATE ERROR BODY');
    });
    await expect(start()).rejects.toThrow('REMOTE PRIVATE'); const dto = listQualificationDtos(left.id)[0];
    expect(dto.state).toBe('blocked'); expect(dto.messages).toHaveLength(1); expect(dto.failureCode).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(dto)).not.toContain('REMOTE PRIVATE'); expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(0);
  });
  it('binds explicit answers to the owner, current version, class and counterpart', async () => {
    await start(); const dto = listQualificationDtos(left.id)[0];
    const body = { version: dto.version, questionId: dto.questions[0].id, text: 'I offer a scoped documentation review.', fieldClass: 'seeking', providerDisclosureConsent: true, shareWithCounterpart: true };
    await expect(answerQualification(right.id, dto.id, body, () => {})).rejects.toMatchObject({ status: 404 });
    await expect(answerQualification(left.id, dto.id, { ...body, fieldClass: 'offering' }, () => {})).rejects.toMatchObject({ code: 'ANSWER_FIELD_DENIED' });
    await answerQualification(left.id, dto.id, body, () => {});
    await expect(answerQualification(left.id, dto.id, body, () => {})).rejects.toMatchObject({ code: 'QUALIFICATION_CHANGED' });
    const record = qualificationRecord(dto.id)!;
    db().prepare("UPDATE qualifications SET state='running',lease_until=? WHERE id=?").run(new Date(Date.now() + 60000).toISOString(), dto.id);
    expect(qualificationAnswerAllowed(left.id, right.id, record.value.answers[0].fieldId, left.a.policy)).toBe(true);
    expect(qualificationAnswerAllowed(left.id, 'foreign', record.value.answers[0].fieldId, left.a.policy)).toBe(false);
    expect(qualificationAnswerAllowed(left.id, right.id, record.value.answers[0].fieldId + 'tamper', left.a.policy)).toBe(false);
  });
  it('rejects resume without an answer and supports cancellation without a provider round', async () => {
    await start(); const dto = listQualificationDtos(left.id)[0];
    await expect(resumeQualification(left.id, dto.id, { version: dto.version }, () => {})).rejects.toMatchObject({ code: 'OWNER_ANSWER_REQUIRED' });
    cancelQualification(right.id, dto.id, { version: dto.version }, () => {});
    expect(listQualificationDtos(left.id)[0].state).toBe('cancelled'); expect(external.qualify).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the owner context changes during inference', async () => {
    external.qualify.mockImplementation(async input => { const a = agent(right.id)!; saveAgent(right.id, { ...a, policy: { ...a.policy, version: 2 } }); return result(input, 'qualified'); });
    await expect(start()).rejects.toMatchObject({ code: 'QUALIFICATION_CHANGED' }); expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(0);
  });
  it('does not create a proposal after either owner cancels during inference', async () => {
    external.qualify.mockImplementation(async input => {
      const current = listQualificationDtos(right.id)[0]; cancelQualification(right.id, current.id, { version: current.version }, () => {});
      return result(input, 'qualified');
    });
    await expect(start()).rejects.toMatchObject({ code: 'QUALIFICATION_STOPPED' });
    expect(listQualificationDtos(left.id)[0].state).toBe('cancelled'); expect(db().prepare('SELECT id FROM proposals').all()).toHaveLength(0);
  });
});
