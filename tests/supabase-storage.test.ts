import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, closeDatabase } from '../packages/server/db';
import { decrypt, encrypt } from '../packages/server/crypto';
import { createDocument, createStoredDocument, deleteStoredDocument, loadDocumentBytes, ownedDocument, updateDocument, reconcilePrivateObjects } from '../packages/server/context-store';
import { bootstrapPrivateContextBucket, checkPrivateStorage, MAX_CIPHERTEXT_BYTES } from '../packages/server/supabase-storage';
let directory: string;
let objects: Map<string, string>;
let publicBucket = false, uploadFailure = false, deleteFailure = false;
let onUpload: (() => void | Promise<void>) | undefined, onDownload: (() => void | Promise<void>) | undefined;
let requests: {
    path: string;
    method: string;
    body: unknown;
}[];
function owner() {
    const id = randomUUID();
    db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@storage-fixture.invalid`, '', null, encrypt({}, `profile:${id}`), new Date().toISOString());
    return id;
}
const metadata = { name: 'private-resume.txt', mimeType: 'text/plain' as const, extractionStatus: 'ready' as const, extractedText: 'Private resume fixture' };
const original = Buffer.from('PRIVATE ORIGINAL, NEVER PUBLIC');
const json = (value: unknown, status = 200) => Response.json(value, { status });
beforeEach(() => {
    closeDatabase();
    directory = mkdtempSync(join(tmpdir(), 'meeti-cloud-storage-'));
    vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('SUPABASE_STORAGE_ENABLED', 'true');
    vi.stubEnv('SUPABASE_URL', 'https://storage-fixture.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only-fixture-key');
    objects = new Map();
    requests = [];
    publicBucket = uploadFailure = deleteFailure = false;
    onUpload = onDownload = undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        const path = new URL(String(input)).pathname, method = options?.method || 'GET';
        requests.push({ path, method, body: options?.body });
        if (path === '/storage/v1/bucket/meeti-context')
            return json({ id: 'meeti-context', name: 'meeti-context', public: publicBucket, file_size_limit: MAX_CIPHERTEXT_BYTES, allowed_mime_types: ['application/octet-stream'] });
        if (method === 'POST' && path.startsWith('/storage/v1/object/meeti-context/')) {
            if (uploadFailure)
                return json({ message: 'Fixture upload failure' }, 503);
            const key = path.slice('/storage/v1/object/meeti-context/'.length);
            objects.set(key, Buffer.from(options!.body as Uint8Array).toString());
            await onUpload?.();
            return json({ Key: `meeti-context/${key}` });
        }
        if (method === 'GET' && path.includes('/object/meeti-context/')) {
            await onDownload?.();
            const key = path.split('/object/meeti-context/')[1];
            return objects.has(key) ? new Response(objects.get(key), { headers: { 'content-type': 'application/octet-stream' } }) : json({}, 404);
        }
        if (method === 'DELETE' && path === '/storage/v1/object/meeti-context') {
            if (deleteFailure)
                return json({ message: 'Fixture delete failure' }, 503);
            const { prefixes } = JSON.parse(String(options?.body));
            for (const key of prefixes)
                objects.delete(key);
            return json([]);
        }
        throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }));
});
afterEach(() => { closeDatabase(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
// Actual Supabase SDK serialization and local encryption/SQLite are exercised against an explicit HTTP fixture.
// These tests do not prove live Supabase permissions or bucket availability.
describe('private Supabase original storage', () => {
    it('validates a private, bounded ciphertext-only bucket', async () => {
        expect(await bootstrapPrivateContextBucket()).toMatchObject({ private: true, encryptedOriginals: true });
        publicBucket = true;
        await expect(checkPrivateStorage()).rejects.toMatchObject({ code: 'PRIVATE_BUCKET_UNSAFE' });
    });
    it('uploads only ciphertext with an opaque owner path and returns bytes only through current ownership', async () => {
        const id = owner(), document = await createStoredDocument(id, metadata, original, () => { });
        expect(objects.size).toBe(1);
        expect([...objects.values()][0]).not.toContain(original.toString());
        expect([...objects.values()][0]).not.toContain(original.toString('base64'));
        expect([...objects.keys()][0]).not.toContain(id);
        expect([...objects.keys()][0]).not.toContain(metadata.name);
        expect((await loadDocumentBytes(id, document.id, () => { })).bytes).toEqual(new Uint8Array(original));
        const before = requests.length;
        await expect(loadDocumentBytes(owner(), document.id, () => { })).rejects.toMatchObject({ status: 404 });
        expect(requests).toHaveLength(before);
        expect(requests.some(request => /public|sign\//.test(request.path))).toBe(false);
        const row = (await ownedDocument(id, document.id)).row;
        expect(decrypt(row.content, `context-content:${id}:${document.id}`)).toMatchObject({ storage: 'supabase', bucket: 'meeti-context' });
    });
    it('preserves local originals after enabling cloud storage', async () => {
        const id = owner(), document = await createDocument(id, metadata, original, () => { });
        expect((await loadDocumentBytes(id, document.id, () => { })).bytes).toEqual(new Uint8Array(original));
        expect(requests).toHaveLength(0);
    });
    it('does not show failed cloud uploads as stored or silently retain a local original', async () => {
        const id = owner();
        uploadFailure = true;
        await expect(createStoredDocument(id, metadata, original, () => { })).rejects.toMatchObject({ code: 'PRIVATE_UPLOAD_FAILED' });
        expect(db().prepare('SELECT * FROM private_context_documents').all()).toEqual([]);
    });
    it('cleans an uploaded orphan when the session changes before its SQLite commit', async () => {
        const id = owner();
        let revoked = false;
        onUpload = () => { revoked = true; };
        await expect(createStoredDocument(id, metadata, original, async () => {
            await Promise.resolve();
            if (revoked)
                throw new Error('Fixture revoked session');
        })).rejects.toThrow('revoked session');
        expect(objects.size).toBe(0);
        expect(db().prepare('SELECT * FROM private_context_documents').all()).toHaveLength(0);
    });
    it('rejects tampered ciphertext and metadata changes during retrieval', async () => {
        const id = owner(), document = await createStoredDocument(id, metadata, original, () => { });
        const key = [...objects.keys()][0], ciphertext = objects.get(key)!;
        objects.set(key, ciphertext.slice(0, -1) + 'x');
        await expect(loadDocumentBytes(id, document.id, () => { })).rejects.toMatchObject({ code: 'DOCUMENT_CHANGED' });
        objects.set(key, ciphertext);
        onDownload = async () => { await updateDocument(id, document.id, { expectedVersion: 1, reviewedExcerpt: 'Reviewed', allowAgentContext: true, allowOriginalShare: false }, () => { }); };
        await expect(loadDocumentBytes(id, document.id, () => { })).rejects.toMatchObject({ code: 'DOCUMENT_CHANGED' });
    });
    it('keeps failed deletion locked and retryable, then removes cloud bytes and local grants', async () => {
        const id = owner(), document = await createStoredDocument(id, metadata, original, () => { });
        deleteFailure = true;
        await expect(deleteStoredDocument(id, document.id, 1, () => { })).rejects.toMatchObject({ code: 'PRIVATE_DELETE_FAILED' });
        await expect(updateDocument(id, document.id, { expectedVersion: 1, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: true }, () => { })).rejects.toThrow('pending deletion');
        await expect(loadDocumentBytes(id, document.id, () => { })).rejects.toMatchObject({ code: 'DOCUMENT_DELETING' });
        deleteFailure = false;
        await deleteStoredDocument(id, document.id, 1, () => { });
        expect(objects.size).toBe(0);
        await expect(ownedDocument(id, document.id)).rejects.toThrow();
    });
    it('durably reconciles failed upload cleanup without touching a different owner', async () => {
        const id = owner();
        deleteFailure = true;
        onUpload = () => { throw new Error('Interrupted upload fixture'); };
        await expect(createStoredDocument(id, metadata, original, () => { })).rejects.toThrow();
        expect(objects.size).toBe(1);
        deleteFailure = false;
        db().prepare('UPDATE operations SET created_at=?').run(new Date(Date.now() - 6 * 60000).toISOString());
        expect(await reconcilePrivateObjects(owner(), () => { })).toEqual({ reconciled: 0, pending: 0 });
        expect(objects.size).toBe(1);
        expect(await reconcilePrivateObjects(id, () => { })).toEqual({ reconciled: 1, pending: 0 });
        expect(objects.size).toBe(0);
    });
});
