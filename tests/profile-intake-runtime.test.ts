import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MeetiAgentService, type StructuredProvider } from '../packages/agents/src';
import type { Profile } from '../packages/shared/src';
const mock = vi.hoisted(() => ({ ai: vi.fn() }));
vi.mock('../packages/server/policy', () => ({ ai: mock.ai }));
import { continueIntake, profileIntakes } from '../packages/server/profile-intake';
import { closeDatabase, db } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { createDocument, updateDocument } from '../packages/server/context-store';
import { createSession, requireUser } from '../packages/server/security';

// Fixture provider output. Source assembly, actual intake validation, SQL sessions and encrypted persistence are real.
let directory: string, userId: string, value: Profile, requests: unknown[];
let generateHook: (() => void) | null;
let fail: boolean;
function session(id = userId) {
  const cookie = createSession(id).split(';')[0], request = new Request('http://127.0.0.1:3198/api/profile/intake', { headers: { cookie } });
  return () => { requireUser(request); };
}
function saveProfile() { db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(value, `profile:${userId}`), userId); }
function excerpt(text = 'Owner-reviewed useful excerpt') {
  const document = createDocument(userId, { name: 'secret-filename.txt', title: 'Confidential file title', mimeType: 'text/plain', extractedText: 'RAW EXTRACTED SECRET', extractionStatus: 'ready' }, Buffer.from('RAW ORIGINAL SECRET'), () => {});
  return updateDocument(userId, document.id, { expectedVersion: 1, reviewedExcerpt: text, allowAgentContext: true, allowOriginalShare: false, sharingScope: 'private-agent' }, () => {});
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-intake-runtime-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  userId = randomUUID(); value = { displayName: 'Owner fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: 'PRIVATE CONTACT SECRET', employer: 'PRIVATE EMPLOYER SECRET', publicFields: [], aiConsent: true,
    roles: ['Developer advocate'], skills: ['Technical writing'], contextSharing: 'private-agent' };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(userId, `${userId}@fixture.test`, '', null, encrypt(value, `profile:${userId}`), new Date().toISOString());
  requests = []; generateHook = null; fail = false;
  const provider: StructuredProvider = { async generate<T>(request: { data: unknown; outputSchema: z.ZodType<T> }) {
    requests.push(request.data); generateHook?.(); if (fail) throw new Error('PRIVATE REMOTE ERROR BODY');
    const now = new Date().toISOString();
    return { output: request.outputSchema.parse({ summary: null, summaryEvidence: [], about: null, offering: [], seeking: [], tags: [], clarificationQuestions: ['What contribution can you offer?'] }),
      inference: { requestId: randomUUID(), providerRequestId: null, model: 'fixture-only', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, startedAt: now, completedAt: now } };
  } };
  mock.ai.mockImplementation(() => new MeetiAgentService(provider, async () => { throw new Error('Owner intake must not authorize counterpart actions.'); }));
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe('owner-only saved intake context', () => {
  it('keeps saved details and excerpts out by default', async () => {
    excerpt(); await continueIntake(userId, { text: 'I want to meet collaborators.', providerDisclosureConsent: true }, session());
    expect(JSON.stringify(requests)).not.toContain('Technical writing'); expect(JSON.stringify(requests)).not.toContain('Owner-reviewed');
  });
  it.each(['private-agent', 'ask-first'] as const)('includes approved owner context under %s scope without counterpart permission', async contextSharing => {
    value.contextSharing = contextSharing; saveProfile(); excerpt();
    await continueIntake(userId, { text: 'I want to meet collaborators.', providerDisclosureConsent: true, includePrivateContext: true }, session());
    const source = JSON.stringify(requests);
    expect(source).toContain('Technical writing'); expect(source).toContain('Owner-reviewed useful excerpt');
    for (const withheld of ['PRIVATE CONTACT SECRET', 'PRIVATE EMPLOYER SECRET', 'RAW EXTRACTED SECRET', 'RAW ORIGINAL SECRET', 'secret-filename.txt', 'Confidential file title']) expect(source).not.toContain(withheld);
    expect(profileIntakes(userId)[0]).not.toHaveProperty('sourceText'); expect(profileIntakes(userId)[0].includePrivateContext).toBe(true);
  });
  it('requires saved global AI consent before reading context or making a model call', async () => {
    value.aiConsent = false; saveProfile(); excerpt();
    await expect(continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true, includePrivateContext: true }, session())).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(requests).toHaveLength(0);
  });
  it('rejects oversized combined source instead of truncating owner facts', async () => {
    excerpt('x'.repeat(1200));
    await expect(continueIntake(userId, { text: 'y'.repeat(7200), providerDisclosureConsent: true, includePrivateContext: true }, session())).rejects.toMatchObject({ code: 'INTAKE_SOURCE_TOO_LONG' }); expect(requests).toHaveLength(0);
  });
  it('blocks excerpt revocation before resuming the exact prior input', async () => {
    const document = excerpt(), initial = await continueIntake(userId, { text: 'My original context.', providerDisclosureConsent: true, includePrivateContext: true }, session());
    updateDocument(userId, document.id, { expectedVersion: document.version, reviewedExcerpt: document.reviewedExcerpt, allowAgentContext: false, allowOriginalShare: false }, () => {});
    await expect(continueIntake(userId, { id: initial.id, version: initial.version, answers: [{ questionId: initial.result.questions[0].id, text: 'I can review docs.', providerDisclosureConsent: true }] }, session())).rejects.toMatchObject({ code: 'INTAKE_CONTEXT_CHANGED' }); expect(requests).toHaveLength(1);
  });
  it('rejects changed private context after a delayed provider response', async () => {
    excerpt(); generateHook = () => { value.skills = ['Changed skill']; saveProfile(); };
    await expect(continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true, includePrivateContext: true }, session())).rejects.toMatchObject({ code: 'INTAKE_CONTEXT_CHANGED' });
    expect(profileIntakes(userId)[0]).toMatchObject({ status: 'failed', failureCode: 'INTAKE_CONTEXT_CHANGED', result: null });
  });
  it('denies guessed intake identifiers across accounts and revoked SQL sessions', async () => {
    const initial = await continueIntake(userId, { text: 'My private context.', providerDisclosureConsent: true }, session());
    const foreign = randomUUID(); db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(foreign, `${foreign}@fixture.test`, '', null, encrypt(value, `profile:${foreign}`), new Date().toISOString());
    await expect(continueIntake(foreign, { id: initial.id, version: initial.version, answers: [{ questionId: initial.result.questions[0].id, text: 'Guessed answer', providerDisclosureConsent: true }] }, session(foreign))).rejects.toMatchObject({ status: 404 });
    const check = session(); db().prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    await expect(continueIntake(userId, { text: 'No session.', providerDisclosureConsent: true }, check)).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' }); expect(requests).toHaveLength(1);
  });
  it('records provider failure without storing its private response body or a fabricated draft', async () => {
    fail = true; await expect(continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true }, session())).rejects.toThrow('PRIVATE REMOTE');
    expect(profileIntakes(userId)[0]).toMatchObject({ status: 'failed', failureCode: 'PROVIDER_UNAVAILABLE', result: null }); expect(JSON.stringify(profileIntakes(userId))).not.toContain('PRIVATE REMOTE');
  });
  it('fences interrupted runs, preserves the prior draft and rejects stale continuation versions', async () => {
    const initial = await continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true }, session());
    let recoveredVersion = 0;
    generateHook = () => {
      db().prepare('UPDATE profile_intakes SET updated_at=? WHERE id=?').run(new Date(Date.now() - 121000).toISOString(), initial.id);
      const recovered = profileIntakes(userId)[0]; recoveredVersion = recovered.version;
      expect(recovered).toMatchObject({ status: 'failed', failureCode: 'INTAKE_INTERRUPTED', result: initial.result });
    };
    const answers = [{ questionId: initial.result.questions[0].id, text: 'I offer documentation review.', providerDisclosureConsent: true as const }];
    await expect(continueIntake(userId, { id: initial.id, version: initial.version, answers }, session())).rejects.toMatchObject({ code: 'INTAKE_CHANGED' });
    expect(profileIntakes(userId)[0]).toMatchObject({ version: recoveredVersion, status: 'failed', failureCode: 'INTAKE_INTERRUPTED', result: initial.result });
    await expect(continueIntake(userId, { id: initial.id, version: initial.version + 1, answers }, session())).rejects.toMatchObject({ code: 'INTAKE_CHANGED' });
    expect(requests).toHaveLength(2);
    generateHook = null;
    await expect(continueIntake(userId, { id: initial.id, version: recoveredVersion, answers }, session())).resolves.toMatchObject({ status: 'ready' });
  });
  it('does not interrupt a currently active intake before its execution window expires', async () => {
    generateHook = () => { expect(profileIntakes(userId)[0]).toMatchObject({ version: 1, status: 'running' }); };
    await expect(continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true }, session())).resolves.toMatchObject({ status: 'ready', version: 1 });
  });
  it('blocks global model consent revoked during the response', async () => {
    generateHook = () => { value.aiConsent = false; saveProfile(); };
    await expect(continueIntake(userId, { text: 'My context.', providerDisclosureConsent: true, includePrivateContext: true }, session())).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(profileIntakes(userId)[0]).toMatchObject({ status: 'failed', failureCode: 'AI_CONSENT_REQUIRED', result: null });
  });
});
