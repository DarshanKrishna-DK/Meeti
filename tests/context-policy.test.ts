import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db, profile, saveAgent } from '../packages/server/db';
import { decrypt, encrypt, hash } from '../packages/server/crypto';
import { approvedContextFields, contextFieldAllowed, privateSnapshotDigest } from '../packages/server/context-policy';
import { createDocument, updateDocument, ownedDocument } from '../packages/server/context-store';
import { participant, publicIntent } from '../packages/server/policy';
import { profileSchema } from '../packages/server/validation';
import { policyHistory } from '../packages/server/policy-history';
import { DEFAULT_POLICY_ACTIONS, DEFAULT_POLICY_FIELDS } from '../packages/shared/src/default-policy';
import type { Agent, Intent, Profile } from '../packages/shared/src';
import { decodeInlinePolicyUri, encodeInlinePolicyUri } from '../packages/ens';
let directory: string, id: string, value: Profile, a: Agent;
function saveProfile() { db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(value, `profile:${id}`), id); }
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-context-policy-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'context.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    id = randomUUID();
    value = { displayName: 'Test owner', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: 'private@example.test', employer: 'Private Company', publicFields: [], aiConsent: false,
        socialLinks: [{ label: 'Portfolio', url: 'https://example.test/work' }] };
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@example.test`, 'unused', null, encrypt(value, `profile:${id}`), new Date().toISOString());
    a = { id: randomUUID(), ensName: 'agent.fixture.eth', owner: '0x' + '11'.repeat(20), delegate: '0x' + '22'.repeat(20), persona: '',
        policy: { version: 1, purpose: 'collaborator', allowedFields: [...DEFAULT_POLICY_FIELDS], allowedActions: [...DEFAULT_POLICY_ACTIONS], expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false }, authority: null, config: {} };
    saveAgent(id, a);
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe('context projection and current permission rules', () => {
    it.each(['private-agent', 'ask-first'] as const)('withholds %s excerpts from counterpart projections even with class permission', async (sharingScope) => {
        const doc = await createDocument(id, { name: 'notes.txt', mimeType: 'text/plain', extractedText: 'Owner reference', extractionStatus: 'ready', title: 'My context', description: 'Help my agent understand me.' }, Buffer.from('Owner reference'), () => { });
        expect(doc).toMatchObject({ title: 'My context', description: 'Help my agent understand me.', sharingScope: 'private-agent', publicExcerptApproved: false });
        value.aiConsent = true;
        saveProfile();
        a.policy.allowedFields.push('documentContext');
        await updateDocument(id, doc.id, { expectedVersion: 1, reviewedExcerpt: 'Private approved excerpt', allowAgentContext: true, allowOriginalShare: false, sharingScope }, () => { });
        expect(await approvedContextFields(id, value)).toEqual([]);
        expect(await contextFieldAllowed(id, 'documentContext:anything', value, a.policy)).toBe(false);
    });
    it('requires exact public-excerpt review and withdraws counterpart context on scope changes', async () => {
        const doc = await createDocument(id, { name: 'notes.txt', mimeType: 'text/plain', extractedText: 'Owner reference', extractionStatus: 'ready' }, Buffer.from('Owner reference'), () => { });
        value.aiConsent = true;
        saveProfile();
        const review = { expectedVersion: 1, reviewedExcerpt: 'I build tools.', allowAgentContext: true, allowOriginalShare: false, sharingScope: 'public' as const };
        await expect(updateDocument(id, doc.id, review, () => { })).rejects.toThrow('Approve the exact reviewed excerpt');
        const saved = await updateDocument(id, doc.id, { ...review, publicExcerptApproved: true }, () => { });
        expect((await approvedContextFields(id, value))[0].value).toBe('I build tools.');
        const fingerprint = await privateSnapshotDigest(id);
        await updateDocument(id, doc.id, { ...review, expectedVersion: saved.version, sharingScope: 'ask-first' }, () => { });
        expect(await approvedContextFields(id, value)).toEqual([]);
        expect(await privateSnapshotDigest(id)).not.toBe(fingerprint);
    });
    it('treats files without a stored scope as ask-first rather than transferring legacy approval', async () => {
        const doc = await createDocument(id, { name: 'notes.txt', mimeType: 'text/plain', extractedText: 'legacy', extractionStatus: 'ready' }, Buffer.from('legacy'), () => { });
        const row = (await ownedDocument(id, doc.id)).row;
        const legacy = decrypt<Record<string, unknown>>(row.metadata, `context-metadata:${id}:${doc.id}`);
        delete legacy.sharingScope;
        delete legacy.publicExcerptApproved;
        legacy.allowAgentContext = true;
        legacy.reviewedExcerpt = 'Old approved excerpt';
        db().prepare('UPDATE private_context_documents SET metadata=? WHERE id=?').run(encrypt(legacy, `context-metadata:${id}:${doc.id}`), doc.id);
        value.aiConsent = true;
        expect((await ownedDocument(id, doc.id)).document.sharingScope).toBe('ask-first');
        expect(await approvedContextFields(id, value)).toEqual([]);
    });
    it('keeps recommended permissions useful without opting into private context', () => {
        expect(DEFAULT_POLICY_ACTIONS).toEqual(expect.arrayContaining(['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message']));
        expect(DEFAULT_POLICY_FIELDS).not.toContain('documentContext');
        expect(DEFAULT_POLICY_FIELDS).not.toContain('socialLinks');
        expect(DEFAULT_POLICY_FIELDS).not.toContain('contact');
        expect(DEFAULT_POLICY_FIELDS).not.toContain('employer');
    });
    it('requires separate owner AI and link approvals plus current ENS class permission', async () => {
        expect(await approvedContextFields(id, value)).toEqual([]);
        value.aiConsent = true;
        expect(await approvedContextFields(id, value)).toEqual([]);
        value.publicFields = ['socialLinks'];
        const [link] = await approvedContextFields(id, value);
        expect(link.value).toContain('https://example.test/work');
        expect(link.providerAllowed).toBe(true);
        expect(link.visibility).toBe('private');
        expect(await contextFieldAllowed(id, link.id, value, a.policy)).toBe(false);
        a.policy.allowedFields.push('socialLinks');
        expect(await contextFieldAllowed(id, link.id, value, a.policy)).toBe(true);
        expect(await contextFieldAllowed(id, 'socialLinks', value, a.policy)).toBe(false);
        value.socialLinks![0].url = 'https://example.test/changed';
        expect(await contextFieldAllowed(id, link.id, value, a.policy)).toBe(false);
        value.publicFields = [];
        expect(await approvedContextFields(id, value)).toEqual([]);
    });
    it('projects only a reviewed excerpt, binds its exact text, and excludes originals and extraction previews', async () => {
        const doc = await createDocument(id, { name: 'private-resume.txt', mimeType: 'text/plain', extractionStatus: 'ready', extractedText: 'RAW PRIVATE RESUME contact@example.test' }, Buffer.from('RAW PRIVATE RESUME'), () => { });
        value.aiConsent = true;
        value.publicFields = [];
        saveProfile();
        expect(await approvedContextFields(id, value)).toEqual([]);
        await updateDocument(id, doc.id, { expectedVersion: 1, reviewedExcerpt: 'I build developer tools.', allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: false }, () => { });
        const [field] = await approvedContextFields(id, value);
        expect(field.id).toMatch(/^documentContext:[a-f0-9]{64}$/);
        expect(field.value).toBe('I build developer tools.');
        expect(field.providerAllowed).toBe(true);
        expect(JSON.stringify(field)).not.toContain('RAW PRIVATE');
        expect(JSON.stringify(field)).not.toContain('private-resume');
        expect(await contextFieldAllowed(id, field.id, value, a.policy)).toBe(false);
        a.policy.allowedFields.push('documentContext');
        expect(await contextFieldAllowed(id, field.id, value, a.policy)).toBe(true);
        await updateDocument(id, doc.id, { expectedVersion: 2, reviewedExcerpt: 'I build climate tools.', allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: false }, () => { });
        expect(await contextFieldAllowed(id, field.id, value, a.policy)).toBe(false);
        value.aiConsent = false;
        expect(await approvedContextFields(id, value)).toEqual([]);
    });
    it('uses bounded approved fields in participants and never public Arkiv records', async () => {
        value.aiConsent = true;
        value.publicFields = ['socialLinks'];
        saveProfile();
        a.policy.allowedFields.push('socialLinks');
        saveAgent(id, a);
        const i: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'I seek a developer tools collaborator.', tags: ['tools'], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), policyVersion: 1, status: 'draft', demoOrigin: true,
            semantics: { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborator', direction: 'collaborating', directionEvidence: 'collaborator', canonicalRole: null, topics: [], offers: [], requirements: [], clarificationQuestions: [] } };
        expect((await participant(id, i)).fields).toHaveLength(1);
        expect(JSON.stringify(await participant(id, i))).not.toContain(value.contact);
        expect(JSON.stringify(encodeInlinePolicyUri(a.policy))).not.toContain('example.test/work');
        expect(decodeInlinePolicyUri(encodeInlinePolicyUri(a.policy)).allowedFields).toContain('socialLinks');
        const projection = JSON.stringify(publicIntent(i, a));
        expect(projection).not.toContain('example.test/work');
        expect(projection).not.toContain('documentContext');
        expect(JSON.stringify(encodeInlinePolicyUri(a.policy))).not.toContain('private-resume');
    });
    it('preserves legacy snapshot hashes without excerpts and invalidates changed approved context', async () => {
        expect(await privateSnapshotDigest(id)).toBe(hash(JSON.stringify(profile(id))));
        const doc = await createDocument(id, { name: 'notes.txt', mimeType: 'text/plain', extractedText: 'private', extractionStatus: 'ready' }, Buffer.from('private'), () => { });
        expect(await privateSnapshotDigest(id)).toBe(hash(JSON.stringify(profile(id))));
        await updateDocument(id, doc.id, { expectedVersion: 1, reviewedExcerpt: 'Reviewed facts', allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: false }, () => { });
        const reviewed = await privateSnapshotDigest(id);
        expect(reviewed).not.toBe(hash(JSON.stringify(profile(id))));
        await updateDocument(id, doc.id, { expectedVersion: 2, reviewedExcerpt: 'Reviewed facts', allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: true }, () => { });
        expect(await privateSnapshotDigest(id)).toBe(reviewed);
    });
});
describe('profile validation and immutable policy history', () => {
    it.each(['javascript:alert(1)', 'http://example.test', 'https://user:password@example.test', 'not a URL'])('rejects unsafe link %s without fetching it', url => {
        expect(profileSchema.safeParse({ ...value, socialLinks: [{ label: 'Unsafe', url }] }).success).toBe(false);
    });
    it('accepts HTTPS owner-supplied links and preserves existing profile compatibility', () => {
        expect(profileSchema.safeParse(value).success).toBe(true);
        const { socialLinks: ignored, ...legacy } = value;
        void ignored;
        expect(profileSchema.safeParse(legacy).success).toBe(true);
        expect(profileSchema.safeParse({ ...value, socialLinks: [...value.socialLinks!, ...value.socialLinks!] }).success).toBe(false);
    });
    it('records each policy revision once without replacing history during authority refresh', async () => {
        expect(await policyHistory(id)).toHaveLength(1);
        saveAgent(id, { ...a, persona: 'An authority refresh cannot rewrite this historical row.' });
        expect((await policyHistory(id))[0].persona).toBe('');
        saveAgent(id, { ...a, policy: { ...a.policy, version: 2, allowedFields: ['headline'] } });
        expect((await policyHistory(id)).map(row => row.policy.version)).toEqual([2, 1]);
        expect(await policyHistory(randomUUID())).toEqual([]);
        const raw = JSON.stringify(db().prepare('SELECT data FROM policy_history').all());
        expect(raw).not.toContain('headline');
    });
});
