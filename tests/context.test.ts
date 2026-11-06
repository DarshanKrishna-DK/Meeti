import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForkOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ContextDocument, Intent, Profile, Room } from '../packages/shared/src';
// Provider substitutions are test fixtures. These results are not live identity or chain evidence.
const fixture = vi.hoisted(() => ({ revoked: new Set<string>(), authority: vi.fn(), publicIdentity: vi.fn(), hangingProcess: false, crashingProcess: false,
    processOptions: [] as unknown[], kill: vi.fn().mockReturnValue(true) }));
vi.mock('../packages/server/identity', async (importOriginal) => ({
    ...await importOriginal<typeof import('../packages/server/identity')>(),
    resolveCurrentPublicAgentIdentityForUser: fixture.publicIdentity,
}));
vi.mock('../packages/server/policy', async (importOriginal) => ({
    ...await importOriginal<typeof import('../packages/server/policy')>(), authority: fixture.authority,
}));
vi.mock('../packages/server/discovery', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../packages/server/discovery')>();
    return { ...actual, freshPublicIntent: async (userId: string, value: Intent, action: string) => fixture.authority(userId, action, value.policyVersion) };
});
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const { EventEmitter } = await import('node:events');
    return { ...actual, fork: (filename: string, args: string[], options: ForkOptions) => {
            fixture.processOptions.push(options);
            if (!fixture.hangingProcess && !fixture.crashingProcess)
                return actual.fork(filename, args, options);
            const stalled = new EventEmitter();
            return Object.assign(stalled, { kill: (signal: string) => { fixture.kill(signal); stalled.emit('exit', 1); return true; },
                send: vi.fn(() => {
                    if (fixture.crashingProcess)
                        queueMicrotask(() => { stalled.emit('exit', 3221225477, null); });
                }) });
        } };
});
import { route } from '../packages/server/router';
import { agent, closeDatabase, db, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { decrypt, encrypt, hash } from '../packages/server/crypto';
import { createSession, HttpError } from '../packages/server/security';
import { approvedDocumentContext, contextFingerprint, createDocument, documentBytes, listDocuments, MAX_DOCUMENT_BYTES, recipientShare, saveOriginalShare, updateDocument, type DocumentRow } from '../packages/server/context-store';
import { privateSnapshotDigest } from '../packages/server/context-policy';
import * as pdf from '../packages/server/pdf-extraction';
const origin = 'http://127.0.0.1:3198';
type Actor = {
    id: string;
    cookie: string;
};
let directory: string;
async function actor(): Promise<Actor> {
    const id = randomUUID();
    const profile: Profile = { displayName: 'Local test fixture', headline: '', bio: '', seeking: '', offering: '', tags: [],
        contact: '', employer: '', publicFields: [], aiConsent: false };
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@example.test`, 'test-only-password', null, encrypt(profile, `profile:${id}`), new Date().toISOString());
    return { id, cookie: (await createSession(id)).split(';')[0] };
}
async function call(owner: Actor | null, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return route(new Request(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...(owner ? { cookie: owner.cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split('/'));
}
async function upload(owner: Actor, text = 'Private project notes with an unapproved email: owner@example.test', name = 'private-notes.txt') {
    const response = await call(owner, 'context/files', { name, mimeType: 'text/plain', contentBase64: Buffer.from(text).toString('base64') });
    expect(response.status).toBe(200);
    return (await response.json()).data as ContextDocument;
}
async function review(owner: Actor, document: ContextDocument, changes: Partial<ContextDocument> = {}) {
    const response = await call(owner, `context/files/${document.id}/update`, { expectedVersion: document.version,
        reviewedExcerpt: document.reviewedExcerpt, allowAgentContext: document.allowAgentContext,
        allowOriginalShare: document.allowOriginalShare, ...changes });
    expect(response.status).toBe(200);
    return (await response.json()).data as ContextDocument;
}
async function pair(left: Actor, right: Actor) {
    function side(owner: Actor): {
        a: Agent;
        intent: Intent;
    } {
        const a: Agent = { id: randomUUID(), ensName: 'test.fixture.eth', owner: `0x${'11'.repeat(20)}`, delegate: `0x${'22'.repeat(20)}`,
            persona: '', authority: null, config: {}, policy: { version: 1, purpose: 'collaborator', allowedFields: ['documentContext'],
                allowedActions: ['message', 'introduce', 'negotiate'], expiresAt: new Date(Date.now() + 3600000).toISOString(), paused: false } };
        saveAgent(owner.id, a);
        const intent: Intent = { id: randomUUID(), version: 1, policyVersion: 1, goal: 'collaborator', summary: 'A fixture intent', tags: ['test'],
            createdAt: new Date().toISOString(), expiresAt: a.policy.expiresAt, status: 'published', demoOrigin: true };
        saveIntent(owner.id, intent);
        return { a, intent };
    }
    const l = side(left), r = side(right), id = randomUUID(), digest = hash(id);
    const value: ProposalData = { leftIntent: l.intent, rightIntent: r.intent, leftPolicy: l.a.policy, rightPolicy: r.a.policy,
        leftAgent: l.a.id, rightAgent: r.a.id, leftProfileDigest: await privateSnapshotDigest(left.id), rightProfileDigest: await privateSnapshotDigest(right.id),
        summary: 'Local fixture proposal', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
    db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, id, 'introduced', digest, encrypt(value, `proposal:${id}`));
    for (const owner of [left, right]) {
        db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, owner.id, 'approve', digest, 'test-only-signature', new Date().toISOString());
        const receiptId = randomUUID();
        db().prepare('INSERT INTO world_verifications VALUES(?,?,?,?,?,?,?,?)').run(receiptId, owner.id, id, digest, hash(randomUUID()), hash(randomUUID()), encrypt({ issuer: 'https://sandbox.auth.world.org', clientId: 'test-only-client', identityMode: 'sandbox-test-identity' }, `world:${receiptId}`), new Date(Date.now() + 60000).toISOString());
    }
    const room: Room = { id: randomUUID(), proposalId: id, title: 'Local fixture room', introduction: '', createdAt: new Date().toISOString() };
    db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id, id, encrypt(room, `room:${room.id}`));
    return { id, digest, room };
}
function makePdf(pages: string[]): Uint8Array {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const pageIds: number[] = [];
    for (const text of pages) {
        const pageId = objects.length + 1, streamId = pageId + 1;
        pageIds.push(pageId);
        const stream = text ? `BT /F1 12 Tf 50 700 Td (${text}) Tj ET` : '';
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    let body = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body);
}
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-private-context-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('APP_ORIGIN', origin);
    vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'true');
    vi.stubEnv('WORLD_ISSUER', 'https://sandbox.auth.world.org');
    vi.stubEnv('WORLD_CLIENT_ID', 'test-only-client');
    vi.stubEnv('WORLD_CLIENT_SECRET', 'test-only-secret');
    fixture.revoked.clear();
    fixture.hangingProcess = false;
    fixture.crashingProcess = false;
    fixture.processOptions.length = 0;
    fixture.kill.mockClear();
    fixture.authority.mockReset().mockImplementation(async (userId: string) => {
        if (fixture.revoked.has(userId))
            throw new HttpError(403, 'ENS_AUTHORITY_DENIED', 'Explicit fixture revocation.');
        return agent(userId);
    });
    // Legacy room fixtures declare no public context or registry association. The binding guard still executes.
    fixture.publicIdentity.mockReset().mockImplementation(async (userId: string) => ({
        ensName: agent(userId)!.ensName, owner: agent(userId)!.owner,
        context: { state: 'absent' }, association: { state: 'absent' },
        observed: { chainId: 11155111, blockNumber: '1', checkedAt: new Date().toISOString() }, authorityVerified: false, humanVerified: false,
    }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeDatabase();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
});
describe('encrypted private document storage and owner boundaries', () => {
    it('encrypts names, metadata, extracted text, and originals with tenant-bound authenticated encryption', async () => {
        const owner = await actor(), other = await actor(), text = 'Private exact original owner@example.test';
        const document = await upload(owner, text, 'private-owner-name.txt');
        expect(document).toMatchObject({ name: 'private-owner-name.txt', extractedText: text, extractionStatus: 'ready', version: 1,
            reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false });
        const row = db().prepare('SELECT * FROM private_context_documents WHERE id=?').get(document.id) as DocumentRow;
        const raw = JSON.stringify(row);
        for (const secret of [document.name, text, Buffer.from(text).toString('base64')])
            expect(raw).not.toContain(secret);
        expect(decrypt(row.metadata, `context-metadata:${owner.id}:${document.id}`)).toEqual(document);
        expect(() => decrypt(row.metadata, `context-metadata:${other.id}:${document.id}`)).toThrow();
        expect(() => decrypt(row.content, `context-metadata:${owner.id}:${document.id}`)).toThrow();
        expect(await approvedDocumentContext(owner.id)).toBe('');
        expect((await (await call(other, 'context/files')).json()).data).toEqual([]);
        expect((await call(other, `context/files/${document.id}/download`)).status).toBe(404);
        expect((await call(null, `context/files/${document.id}/download`)).status).toBe(401);
        const download = await call(owner, `context/files/${document.id}/download`);
        expect(await download.text()).toBe(text);
        expect(download.headers.get('content-type')).toBe('application/octet-stream');
        expect(download.headers.get('content-disposition')).toContain('attachment;');
        expect(download.headers.get('content-security-policy')).toContain('sandbox');
        expect(download.headers.get('x-content-type-options')).toBe('nosniff');
        closeDatabase();
        expect(await listDocuments(owner.id)).toEqual([document]);
        expect(Buffer.from((await documentBytes(owner.id, document.id)).bytes).toString()).toBe(text);
    });
    it.each([
        ['path traversal', { name: '../private.txt' }],
        ['invalid filename Unicode', { name: 'private-\ud800.txt' }],
        ['MIME mismatch', { name: 'private.pdf', mimeType: 'text/plain' }],
        ['unsupported extension', { name: 'private.docx' }],
        ['invalid base64', { contentBase64: 'aGVsbG8=!' }],
        ['noncanonical base64', { contentBase64: 'YR==' }],
        ['HTML', { contentBase64: Buffer.from('<html><body>Private</body></html>').toString('base64') }],
        ['HTML fragment', { contentBase64: Buffer.from('<div>Private document</div>').toString('base64') }],
        ['executable script', { contentBase64: Buffer.from('#!/bin/sh\necho private').toString('base64') }],
        ['binary data', { contentBase64: Buffer.from([0, 1, 2, 3]).toString('base64') }],
        ['invalid UTF-8', { contentBase64: Buffer.from([0xc3, 0x28]).toString('base64') }],
        ['false PDF magic', { name: 'private.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('<html>%%EOF').toString('base64') }],
    ])('rejects %s before creating a record', async (_label, changes) => {
        const owner = await actor();
        const response = await call(owner, 'context/files', { name: 'private.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64'), ...changes });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await listDocuments(owner.id)).toEqual([]);
        expect(fixture.processOptions).toHaveLength(0);
    });
    it('requires same-origin mutations and blocks another tenant update or delete', async () => {
        const owner = await actor(), other = await actor(), document = await upload(owner);
        const input = { expectedVersion: 1, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false };
        expect((await call(owner, `context/files/${document.id}/update`, input, { origin: 'https://other.invalid' })).status).toBe(403);
        expect((await call(other, `context/files/${document.id}/update`, input)).status).toBe(404);
        expect((await call(other, `context/files/${document.id}/delete`, { expectedVersion: 1 })).status).toBe(404);
        expect(await listDocuments(owner.id)).toHaveLength(1);
    });
    it('enforces the exact 1 MiB bound and atomic five-document quota without leaking originals to models', async () => {
        const owner = await actor();
        const maximum = 'a'.repeat(MAX_DOCUMENT_BYTES);
        const document = await upload(owner, maximum);
        expect(document.size).toBe(MAX_DOCUMENT_BYTES);
        expect(document.extractedText).toHaveLength(12000);
        expect((await call(owner, 'context/files', { name: 'large.txt', mimeType: 'text/plain', contentBase64: Buffer.from(maximum + 'b').toString('base64') })).status).toBe(413);
        for (let index = 0; index < 4; index++)
            await upload(owner, 'A private note');
        expect((await call(owner, 'context/files', { name: 'sixth.txt', mimeType: 'text/plain', contentBase64: Buffer.from('sixth').toString('base64') })).status).toBe(413);
        expect(await listDocuments(owner.id)).toHaveLength(5);
        expect(await approvedDocumentContext(owner.id)).toBe('');
        expect(fixture.authority).not.toHaveBeenCalled();
    });
    it('uses expected versions, limits reviewed excerpts, and projects only explicitly approved review text', async () => {
        const owner = await actor(), raw = 'Unapproved original and raw prompt';
        expect(await contextFingerprint(owner.id)).toBe('');
        let document = await upload(owner, raw, 'never-send-this-filename.txt');
        const originalFingerprint = await contextFingerprint(owner.id);
        expect(originalFingerprint).toBe('');
        expect(originalFingerprint).toBe(await contextFingerprint(owner.id));
        document = await review(owner, document, { reviewedExcerpt: 'Only this owner-reviewed excerpt.', allowAgentContext: true, sharingScope: 'authorized-counterpart' });
        expect(document.version).toBe(2);
        expect(await contextFingerprint(owner.id)).not.toBe(originalFingerprint);
        expect(await approvedDocumentContext(owner.id)).toBe('Only this owner-reviewed excerpt.');
        expect(await approvedDocumentContext(owner.id)).not.toContain(raw);
        expect(await approvedDocumentContext(owner.id)).not.toContain(document.name);
        const current = { expectedVersion: document.version, reviewedExcerpt: document.reviewedExcerpt, allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: false };
        const unchanged = await call(owner, `context/files/${document.id}/update`, current);
        expect((await unchanged.json()).data.version).toBe(2);
        expect((await call(owner, `context/files/${document.id}/update`, { ...current, expectedVersion: 1 })).status).toBe(409);
        expect((await call(owner, `context/files/${document.id}/delete`, { expectedVersion: 1 })).status).toBe(409);
        expect((await call(owner, `context/files/${document.id}/update`, { ...current, reviewedExcerpt: 'a'.repeat(1201) })).status).toBe(400);
        expect((await call(owner, `context/files/${document.id}/update`, { ...current, reviewedExcerpt: '' })).status).toBe(400);
        for (let index = 0; index < 2; index++) {
            const next = await upload(owner, 'Private raw');
            await review(owner, next, { reviewedExcerpt: 'b'.repeat(1200), allowAgentContext: true, sharingScope: 'authorized-counterpart' });
        }
        expect((await approvedDocumentContext(owner.id)).length).toBeLessThanOrEqual(1500);
        expect((await call(owner, `context/files/${document.id}/delete`, { expectedVersion: 2 })).status).toBe(200);
        await expect(documentBytes(owner.id, document.id)).rejects.toThrow('not found');
    });
    it('uses a real isolated PDF process for the first five pages and handles blank and corrupt documents honestly', async () => {
        const owner = await actor(), bytes = makePdf(['PAGE_ONE', 'PAGE_TWO', 'PAGE_THREE', 'PAGE_FOUR', 'PAGE_FIVE', 'PAGE_SIX']);
        const response = await call(owner, 'context/files', { name: 'six-pages.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(bytes).toString('base64') });
        expect(response.status).toBe(200);
        const document = (await response.json()).data as ContextDocument;
        expect(document.extractionStatus).toBe('ready');
        expect(document.extractedText).toContain('PAGE_FIVE');
        expect(document.extractedText).not.toContain('PAGE_SIX');
        expect(document.reviewedExcerpt).toBe('');
        expect(fixture.processOptions[0]).toMatchObject({ env: {}, execArgv: ['--max-old-space-size=128'], windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const blank = await pdf.extractPrivatePdf(makePdf(['']));
        expect(blank).toEqual({ extractionStatus: 'no-text', extractedText: '' });
        expect(await pdf.extractPrivatePdf(Buffer.from('%PDF-1.4\ncorrupt\n%%EOF'))).toEqual({ extractionStatus: 'failed', extractedText: '' });
    });
    it('terminates a stalled parser at eight seconds without returning partial or fabricated text', async () => {
        fixture.hangingProcess = true;
        vi.useFakeTimers();
        const result = pdf.extractPrivatePdf(makePdf(['PRIVATE']));
        await vi.advanceTimersByTimeAsync(7999);
        expect(fixture.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual({ extractionStatus: 'failed', extractedText: '' });
        expect(fixture.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    });
    it('contains a parser process crash and permits at most two concurrent extractions', async () => {
        fixture.crashingProcess = true;
        expect(await pdf.extractPrivatePdf(makePdf(['PRIVATE']))).toEqual({ extractionStatus: 'failed', extractedText: '' });
        fixture.crashingProcess = false;
        fixture.hangingProcess = true;
        fixture.kill.mockClear();
        vi.useFakeTimers();
        const first = pdf.extractPrivatePdf(makePdf(['FIRST'])), second = pdf.extractPrivatePdf(makePdf(['SECOND']));
        expect(await pdf.extractPrivatePdf(makePdf(['THIRD']))).toEqual({ extractionStatus: 'failed', extractedText: '' });
        expect(fixture.processOptions).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(8000);
        expect(await first).toEqual({ extractionStatus: 'failed', extractedText: '' });
        expect(await second).toEqual({ extractionStatus: 'failed', extractedText: '' });
        expect(fixture.kill).toHaveBeenCalledTimes(2);
    });
    it('rechecks the session and quotas after awaited extraction before any document write', async () => {
        const owner = await actor();
        let finish!: (value: pdf.PdfExtraction) => void;
        const waiting = new Promise<pdf.PdfExtraction>(resolve => { finish = resolve; });
        const spy = vi.spyOn(pdf, 'extractPrivatePdf').mockReturnValue(waiting);
        const pending = call(owner, 'context/files', { name: 'delayed.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(makePdf(['PRIVATE'])).toString('base64') });
        await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
        db().prepare('DELETE FROM sessions WHERE user_id=?').run(owner.id);
        finish({ extractionStatus: 'ready', extractedText: 'Private extracted text' });
        expect((await pending).status).toBe(401);
        expect(await listDocuments(owner.id)).toEqual([]);
        const newOwner = await actor();
        const second = new Promise<pdf.PdfExtraction>(resolve => { finish = resolve; });
        spy.mockReturnValue(second);
        const concurrent = call(newOwner, 'context/files', { name: 'delayed.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(makePdf(['PRIVATE'])).toString('base64') });
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
        for (let index = 0; index < 5; index++)
            await createDocument(newOwner.id, { name: 'fixture.txt', mimeType: 'text/plain', extractedText: 'Fixture', extractionStatus: 'ready' }, Buffer.from('Fixture'), () => { });
        finish({ extractionStatus: 'ready', extractedText: 'Private extracted text' });
        expect((await concurrent).status).toBe(413);
        expect(await listDocuments(newOwner.id)).toHaveLength(5);
    });
});
describe('original file grants require current protected introduction authority', () => {
    it('grants only the existing room counterpart, binds one file version, and denies revocation, expiry, or changed consent', async () => {
        const owner = await actor(), recipient = await actor(), outsider = await actor();
        let document = await upload(owner, 'Original secret file');
        const p = await pair(owner, recipient);
        const snapshot = await privateSnapshotDigest(owner.id);
        document = await review(owner, document, { allowOriginalShare: true });
        await upload(owner, 'Another unused private original');
        expect(await privateSnapshotDigest(owner.id)).toBe(snapshot);
        const response = await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id });
        expect(response.status).toBe(200);
        const grant = (await response.json()).data as {
            id: string;
            url: string;
            expiresAt: string;
        };
        const again = await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id });
        expect((await again.json()).data.id).toBe(grant.id);
        expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60000);
        expect((await call(outsider, grant.url.slice(5))).status).toBe(404);
        expect((await call(owner, grant.url.slice(5))).status).toBe(404);
        const released = await call(recipient, grant.url.slice(5));
        expect(released.status).toBe(200);
        expect(await released.text()).toBe('Original secret file');
        expect((await call(recipient, `context/files/${document.id}/download`)).status).toBe(404);
        fixture.revoked.add(owner.id);
        expect((await call(recipient, grant.url.slice(5))).status).toBe(403);
        fixture.revoked.clear();
        db().prepare('UPDATE world_verifications SET expires_at=? WHERE proposal_id=?').run(new Date(0).toISOString(), p.id);
        expect((await call(recipient, grant.url.slice(5))).status).toBe(403);
        db().prepare('UPDATE world_verifications SET expires_at=? WHERE proposal_id=?').run(new Date(Date.now() + 60000).toISOString(), p.id);
        db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), p.id, recipient.id, 'revoke', p.digest, 'test-only-signature', new Date().toISOString());
        expect((await call(recipient, grant.url.slice(5))).status).toBe(403);
        await review(owner, document, { allowOriginalShare: false });
        expect(await privateSnapshotDigest(owner.id)).toBe(snapshot);
        expect((await call(recipient, grant.url.slice(5))).status).toBe(404);
    });
    it('keeps all original sharing locked when World is paused and denies a missing room or forbidden field', async () => {
        const owner = await actor(), recipient = await actor();
        let document = await upload(owner);
        document = await review(owner, document, { allowOriginalShare: true });
        const p = await pair(owner, recipient);
        vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
        const paused = await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id });
        expect(paused.status).toBe(503);
        expect((await paused.json()).error.code).toBe('WORLD_PAUSED');
        expect(fixture.authority).not.toHaveBeenCalled();
        expect(db().prepare('SELECT COUNT(*) AS n FROM private_context_shares').get()).toEqual({ n: 0 });
        vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'true');
        db().prepare('DELETE FROM rooms WHERE id=?').run(p.room.id);
        expect((await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id })).status).toBe(409);
        db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(p.room.id, p.id, encrypt(p.room, `room:${p.room.id}`));
        const a = agent(owner.id)!;
        fixture.authority.mockImplementation(async (id: string) => id === owner.id ? { ...a, policy: { ...a.policy, allowedFields: [] } } : agent(id));
        const denied = await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id });
        expect(denied.status).toBe(403);
        expect((await denied.json()).error.code).toBe('DOCUMENT_POLICY_DENIED');
    });
    it('invalidates original grants and proposal snapshots on document change and removes documents on account deletion', async () => {
        const owner = await actor(), recipient = await actor();
        let document = await upload(owner);
        document = await review(owner, document, { allowOriginalShare: true });
        const p = await pair(owner, recipient), snapshot = await privateSnapshotDigest(owner.id);
        const grantId = await saveOriginalShare({ documentId: document.id, ownerId: owner.id, recipientId: recipient.id, proposalId: p.id,
            roomId: p.room.id, version: document.version, policyDigest: 'test-only-digest', proposalDigest: p.digest, expiresAt: new Date(Date.now() + 60000).toISOString() });
        expect((await recipientShare(recipient.id, grantId)).documentId).toBe(document.id);
        await updateDocument(owner.id, document.id, { expectedVersion: document.version, reviewedExcerpt: 'Changed review', allowAgentContext: true, sharingScope: 'authorized-counterpart', allowOriginalShare: true }, () => { });
        expect(await privateSnapshotDigest(owner.id)).not.toBe(snapshot);
        await expect(recipientShare(recipient.id, grantId)).rejects.toThrow('not found');
        const stale = await call(owner, `context/files/${document.id}/share`, { expectedVersion: document.version, proposalId: p.id });
        expect(stale.status).toBe(409);
        db().prepare('DELETE FROM users WHERE id=?').run(owner.id);
        expect(await listDocuments(owner.id)).toEqual([]);
        expect(await contextFingerprint(owner.id)).toBe('');
    });
});
