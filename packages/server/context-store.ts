import { randomUUID } from 'node:crypto';
import type { ContextDocument } from '../shared/src';
import { atomic, db } from './store';
import { decrypt, encrypt, hash } from './crypto';
import { HttpError } from './security';
import { downloadPrivateObject, uploadPrivateObject, removePrivateObject, privateStorageEnabled, PRIVATE_CONTEXT_BUCKET, type PrivateObject } from './supabase-storage';
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_DOCUMENTS = 5;
export const MAX_TOTAL_DOCUMENT_BYTES = 5 * MAX_DOCUMENT_BYTES;
export const MAX_EXTRACTED_TEXT = 12000;
export const MAX_REVIEWED_EXCERPT = 1200;
export type DocumentRow = {
    id: string;
    user_id: string;
    version: number;
    size: number;
    metadata: string;
    content: string;
};
export type OriginalShare = {
    documentId: string;
    ownerId: string;
    recipientId: string;
    proposalId: string;
    roomId: string;
    version: number;
    proposalDigest: string;
    policyDigest: string;
    expiresAt: string;
};
type ShareRow = {
    id: string;
    document_id: string;
    user_id: string;
    recipient_id: string;
    proposal_id: string;
    version: number;
    expires_at: string;
    data: string;
};
function documentMetadata(row: DocumentRow): ContextDocument {
    const value = decrypt<ContextDocument>(row.metadata, `context-metadata:${row.user_id}:${row.id}`);
    if (value.id !== row.id || value.version !== row.version || value.size !== row.size)
        throw new Error('Private document metadata is invalid.');
    return { ...value, title: value.title || value.name, description: value.description || '', sharingScope: value.sharingScope || 'ask-first', publicExcerptApproved: value.publicExcerptApproved === true };
}
export async function ownedDocument(userId: string, id: string): Promise<{
    row: DocumentRow;
    document: ContextDocument;
}> {
    const row = await db().prepare('SELECT * FROM private_context_documents WHERE id=? AND user_id=?').get(id, userId) as DocumentRow | undefined;
    if (!row)
        throw new HttpError(404, 'NOT_FOUND', 'Private document was not found.');
    return { row, document: documentMetadata(row) };
}
export async function listDocuments(userId: string): Promise<ContextDocument[]> {
    return (await db().prepare('SELECT * FROM private_context_documents WHERE user_id=? ORDER BY id').all(userId) as DocumentRow[]).map(documentMetadata);
}
export async function contextFingerprint(userId: string): Promise<string> {
    const projection = (await listDocuments(userId)).filter(counterpartExcerptAllowed)
        .map(value => ({ id: value.id, reviewedExcerpt: value.reviewedExcerpt.trim(), allowAgentContext: true }));
    return projection.length ? hash(JSON.stringify(projection)) : '';
}
/** Return only owner-reviewed reference text. Filenames and extracted previews never enter this projection. */
export async function approvedDocumentContext(userId: string): Promise<string> {
    return (await listDocuments(userId)).filter(counterpartExcerptAllowed)
        .map(value => value.reviewedExcerpt.trim()).join('\n\n').slice(0, 1500);
}
function counterpartExcerptAllowed(value: ContextDocument): boolean {
    return value.allowAgentContext && Boolean(value.reviewedExcerpt.trim()) && (value.sharingScope === 'authorized-counterpart' || value.sharingScope === 'public' && value.publicExcerptApproved === true);
}
type DocumentInput = Pick<ContextDocument, 'name' | 'mimeType' | 'extractedText' | 'extractionStatus' | 'title' | 'description'>;
type DocumentReview = Pick<ContextDocument, 'reviewedExcerpt' | 'allowAgentContext' | 'allowOriginalShare' | 'title' | 'description' | 'sharingScope' | 'publicExcerptApproved'> & {
    expectedVersion: number;
};
function validateDescription(input: {
    title?: string;
    description?: string;
}) {
    if (input.title !== undefined && (!input.title.trim() || input.title.length > 120 || /[\x00-\x1f\x7f]/.test(input.title))
        || input.description !== undefined && (input.description.length > 500 || input.description.includes('\0')))
        throw new HttpError(400, 'INVALID_DOCUMENT_DESCRIPTION', 'Use a title of at most 120 characters and a purpose of at most 500 characters.');
}
export async function assertDocumentCapacity(userId: string, size: number): Promise<void> {
    const usage = await db().prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS total FROM private_context_documents WHERE user_id=?').get(userId) as {
        count: number | string;
        total: number | string;
    };
    // PostgreSQL returns bigint aggregates as strings. Validate before adding byte counts.
    const count = Number(usage.count), total = Number(usage.total);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total) || total < 0) throw new HttpError(503, 'DOCUMENT_USAGE_UNAVAILABLE', 'Private document capacity could not be verified.');
    if (count >= MAX_DOCUMENTS || total + size > MAX_TOTAL_DOCUMENT_BYTES) {
        throw new HttpError(413, 'DOCUMENT_LIMIT', 'You can keep up to five private documents with a total size of 5 MiB. Delete a document before adding another.');
    }
}
export async function createDocument(userId: string, input: DocumentInput, bytes: Uint8Array, checkSession: () => void | Promise<void>): Promise<ContextDocument> {
    return await atomic(async () => {
        await checkSession();
        validateDescription(input);
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCUMENT_BYTES)
            throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'Private documents must contain between one byte and 1 MiB.');
        await assertDocumentCapacity(userId, bytes.byteLength);
        const id = randomUUID(), createdAt = new Date().toISOString();
        const document: ContextDocument = { ...input, extractedText: input.extractedText.slice(0, MAX_EXTRACTED_TEXT), id,
            title: input.title?.trim() || input.name, description: input.description || '', sharingScope: 'private-agent', publicExcerptApproved: false,
            size: bytes.byteLength, version: 1, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false, createdAt, updatedAt: createdAt };
        await db().prepare('INSERT INTO private_context_documents(id,user_id,version,size,metadata,content) VALUES(?,?,?,?,?,?)')
            .run(id, userId, 1, document.size, encrypt(document, `context-metadata:${userId}:${id}`), encrypt({ contentBase64: Buffer.from(bytes).toString('base64') }, `context-content:${userId}:${id}`));
        return document;
    });
}
export function assertDocumentVersion(document: ContextDocument, expectedVersion: number): void {
    if (document.version !== expectedVersion)
        throw new HttpError(409, 'DOCUMENT_CHANGED', 'This private document changed. Refresh and review its current version.');
}
export async function updateDocument(userId: string, id: string, input: DocumentReview, checkSession: () => void | Promise<void>): Promise<ContextDocument> {
    return await atomic(async () => {
        await checkSession();
        await assertNotDeleting(userId, id);
        const { document } = await ownedDocument(userId, id);
        assertDocumentVersion(document, input.expectedVersion);
        validateDescription(input);
        const title = input.title?.trim() || document.title || document.name, description = input.description ?? document.description ?? '';
        const sharingScope = input.sharingScope || document.sharingScope || 'ask-first';
        if (!['private-agent', 'authorized-counterpart', 'ask-first', 'public'].includes(sharingScope))
            throw new HttpError(400, 'INVALID_DOCUMENT_SCOPE', 'Choose a supported excerpt sharing scope.');
        if (sharingScope === 'public' && (input.publicExcerptApproved !== true || !input.reviewedExcerpt.trim()))
            throw new HttpError(400, 'PUBLIC_EXCERPT_REVIEW_REQUIRED', 'Approve the exact reviewed excerpt before selecting public excerpt scope.');
        const publicExcerptApproved = sharingScope === 'public' && input.publicExcerptApproved === true;
        if (input.reviewedExcerpt.length > MAX_REVIEWED_EXCERPT || input.reviewedExcerpt.includes('\0'))
            throw new HttpError(400, 'INVALID_EXCERPT', 'The reviewed excerpt must be plain text of at most 1200 characters.');
        if (input.allowAgentContext && !input.reviewedExcerpt.trim())
            throw new HttpError(400, 'EXCERPT_REQUIRED', 'Review and save an excerpt before allowing agent context.');
        if (document.reviewedExcerpt === input.reviewedExcerpt && document.allowAgentContext === input.allowAgentContext && document.allowOriginalShare === input.allowOriginalShare
            && document.title === title && document.description === description && document.sharingScope === sharingScope && document.publicExcerptApproved === publicExcerptApproved)
            return document;
        const value: ContextDocument = { ...document, title, description, sharingScope, publicExcerptApproved, reviewedExcerpt: input.reviewedExcerpt, allowAgentContext: input.allowAgentContext,
            allowOriginalShare: input.allowOriginalShare, version: document.version + 1, updatedAt: new Date().toISOString() };
        const updated = await db().prepare('UPDATE private_context_documents SET version=?,metadata=? WHERE id=? AND user_id=? AND version=?')
            .run(value.version, encrypt(value, `context-metadata:${userId}:${id}`), id, userId, document.version);
        if (updated.changes !== 1) throw new HttpError(409, 'DOCUMENT_CHANGED', 'This private document changed. Refresh and review its current version.');
        await db().prepare('DELETE FROM private_context_shares WHERE document_id=?').run(id);
        return value;
    });
}
export async function deleteDocument(userId: string, id: string, expectedVersion: number, checkSession: () => void | Promise<void>): Promise<void> {
    const remove = async () => {
        await checkSession();
        const { document } = await ownedDocument(userId, id);
        assertDocumentVersion(document, expectedVersion);
        const deleted = await db().prepare('DELETE FROM private_context_documents WHERE id=? AND user_id=? AND version=?').run(id, userId, expectedVersion);
        if (deleted.changes !== 1) throw new HttpError(409, 'DOCUMENT_CHANGED', 'This private document changed. Refresh and review its current version.');
    };
    if (db().isTransaction)
        await remove();
    else
        await atomic(remove);
}
export async function documentBytes(userId: string, id: string): Promise<{
    document: ContextDocument;
    bytes: Uint8Array;
}> {
    const { row, document } = await ownedDocument(userId, id);
    await assertNotDeleting(userId, id);
    const content = decrypt<{
        contentBase64?: string;
        storage?: string;
    }>(row.content, `context-content:${userId}:${id}`);
    if (content.storage || !content.contentBase64)
        throw new HttpError(503, 'PRIVATE_CLOUD_READ_REQUIRED', 'Retrieve this private original through the protected cloud download route.');
    const bytes = Uint8Array.from(Buffer.from(content.contentBase64, 'base64'));
    if (bytes.byteLength !== document.size)
        throw new Error('Private document content is invalid.');
    return { document, bytes };
}
async function assertNotDeleting(userId: string, id: string) {
    if (await db().prepare("SELECT id FROM operations WHERE user_id=? AND kind=? AND state='storage_deleting'").get(userId, `private-storage:${id}`))
        throw new HttpError(409, 'DOCUMENT_DELETING', 'This private original has a pending deletion. Retry or reconcile that deletion first.');
}
type StorageJournal = {
    documentId: string;
    pointer: PrivateObject;
    expectedVersion: number;
    action: 'upload' | 'delete';
};
async function journal(userId: string, value: StorageJournal): Promise<string> {
    const id = randomUUID();
    await db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(id, userId, `private-storage:${value.documentId}`, value.action === 'delete' ? 'storage_deleting' : 'storage_pending', encrypt(value, `operation:${id}`), new Date().toISOString());
    return id;
}
async function clearJournal(id: string) { await db().prepare('DELETE FROM operations WHERE id=?').run(id); }
export async function createStoredDocument(userId: string, input: DocumentInput, bytes: Uint8Array, checkSession: () => void | Promise<void>): Promise<ContextDocument> {
    if (!privateStorageEnabled())
        return await createDocument(userId, input, bytes, checkSession);
    await checkSession();
    validateDescription(input);
    await assertDocumentCapacity(userId, bytes.byteLength);
    if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES)
        throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'Private documents must contain between one byte and 1 MiB.');
    const id = randomUUID(), timestamp = new Date().toISOString();
    const ciphertext = encrypt({ contentBase64: Buffer.from(bytes).toString('base64') }, `context-content:${userId}:${id}`);
    const pointer: PrivateObject = { storage: 'supabase', bucket: PRIVATE_CONTEXT_BUCKET, path: `${hash(userId)}/${randomUUID()}`, cipherDigest: hash(ciphertext), cipherBytes: Buffer.byteLength(ciphertext) };
    const operationId = await atomic(async () => {
        await checkSession();
        await assertDocumentCapacity(userId, bytes.byteLength);
        return await journal(userId, { documentId: id, pointer, expectedVersion: 1, action: 'upload' });
    });
    try {
        await uploadPrivateObject(pointer, ciphertext);
        return await atomic(async () => {
            await checkSession();
            await assertDocumentCapacity(userId, bytes.byteLength);
            const document: ContextDocument = { ...input, extractedText: input.extractedText.slice(0, MAX_EXTRACTED_TEXT), id, size: bytes.byteLength, version: 1,
                title: input.title?.trim() || input.name, description: input.description || '', sharingScope: 'private-agent', publicExcerptApproved: false,
                reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false, createdAt: timestamp, updatedAt: timestamp };
            await db().prepare('INSERT INTO private_context_documents VALUES(?,?,?,?,?,?)').run(id, userId, 1, document.size, encrypt(document, `context-metadata:${userId}:${id}`), encrypt(pointer, `context-content:${userId}:${id}`));
            await clearJournal(operationId);
            return document;
        });
    }
    catch (error) {
        try {
            await removePrivateObject(pointer);
            await clearJournal(operationId);
        }
        catch {
            await db().prepare("UPDATE operations SET state='storage_cleanup' WHERE id=?").run(operationId);
        }
        throw error;
    }
}
export async function loadDocumentBytes(userId: string, id: string, checkSession: () => void | Promise<void>): Promise<{
    document: ContextDocument;
    bytes: Uint8Array;
}> {
    const initial = await ownedDocument(userId, id);
    await assertNotDeleting(userId, id);
    await checkSession();
    const content = decrypt<{
        contentBase64?: string;
    } | PrivateObject>(initial.row.content, `context-content:${userId}:${id}`);
    if (!('storage' in content))
        return await documentBytes(userId, id);
    if (!privateStorageEnabled())
        throw new HttpError(503, 'PRIVATE_STORAGE_PAUSED', 'Cloud document retrieval is currently paused.');
    if (content.path.split('/')[0] !== hash(userId))
        throw new HttpError(503, 'PRIVATE_OBJECT_INVALID', 'The private object owner reference is invalid.');
    const ciphertext = await downloadPrivateObject(content);
    await checkSession();
    const current = await ownedDocument(userId, id);
    await assertNotDeleting(userId, id);
    assertDocumentVersion(current.document, initial.document.version);
    if (current.row.content !== initial.row.content || hash(ciphertext) !== content.cipherDigest)
        throw new HttpError(409, 'DOCUMENT_CHANGED', 'The private original changed during retrieval.');
    const decoded = decrypt<{
        contentBase64: string;
    }>(ciphertext, `context-content:${userId}:${id}`);
    const bytes = Uint8Array.from(Buffer.from(decoded.contentBase64, 'base64'));
    if (bytes.byteLength !== current.document.size)
        throw new HttpError(503, 'PRIVATE_OBJECT_INVALID', 'The private original size is invalid.');
    return { document: current.document, bytes };
}
export async function deleteStoredDocument(userId: string, id: string, expectedVersion: number, checkSession: () => void | Promise<void>): Promise<void> {
    const initial = await ownedDocument(userId, id);
    assertDocumentVersion(initial.document, expectedVersion);
    await checkSession();
    const content = decrypt<{
        contentBase64?: string;
    } | PrivateObject>(initial.row.content, `context-content:${userId}:${id}`);
    if (!('storage' in content))
        return await deleteDocument(userId, id, expectedVersion, checkSession);
    if (!privateStorageEnabled())
        throw new HttpError(503, 'PRIVATE_STORAGE_PAUSED', 'Cloud document deletion is currently paused.');
    if (content.path.split('/')[0] !== hash(userId))
        throw new HttpError(503, 'PRIVATE_OBJECT_INVALID', 'The private object owner reference is invalid.');
    const operationId = await atomic(async () => {
        await checkSession();
        const current = await ownedDocument(userId, id);
        assertDocumentVersion(current.document, expectedVersion);
        if (current.row.content !== initial.row.content)
            throw new HttpError(409, 'DOCUMENT_CHANGED', 'The private original changed before deletion.');
        return await journal(userId, { documentId: id, pointer: content, expectedVersion, action: 'delete' });
    });
    await removePrivateObject(content);
    await atomic(async () => {
        await checkSession();
        const current = await ownedDocument(userId, id);
        assertDocumentVersion(current.document, expectedVersion);
        if (current.row.content !== initial.row.content)
            throw new HttpError(409, 'DOCUMENT_CHANGED', 'The private original changed during deletion.');
        await deleteDocument(userId, id, expectedVersion, checkSession);
        await db().prepare('DELETE FROM operations WHERE user_id=? AND kind=?').run(userId, `private-storage:${id}`);
        await clearJournal(operationId);
    });
}
/** Reconcile only old encrypted object journals for the authenticated owner. Never scan or delete arbitrary bucket paths. */
export async function reconcilePrivateObjects(userId: string, checkSession: () => void | Promise<void>): Promise<{
    reconciled: number;
    pending: number;
}> {
    if (!privateStorageEnabled())
        throw new HttpError(503, 'PRIVATE_STORAGE_PAUSED', 'Private storage reconciliation is paused.');
    const rows = await db().prepare("SELECT id,data FROM operations WHERE user_id=? AND state IN ('storage_pending','storage_cleanup','storage_deleting') AND created_at<? LIMIT 5")
        .all(userId, new Date(Date.now() - 5 * 60000).toISOString()) as {
        id: string;
        data: string;
    }[];
    let reconciled = 0, pending = 0;
    for (const row of rows) {
        await checkSession();
        const value = decrypt<StorageJournal>(row.data, `operation:${row.id}`);
        if (value.pointer.path.split('/')[0] !== hash(userId)) {
            pending++;
            continue;
        }
        const existing = await db().prepare('SELECT content,version FROM private_context_documents WHERE id=? AND user_id=?').get(value.documentId, userId) as {
            content: string;
            version: number;
        } | undefined;
        if (existing) {
            const currentPointer = decrypt<PrivateObject>(existing.content, `context-content:${userId}:${value.documentId}`);
            if (JSON.stringify(currentPointer) !== JSON.stringify(value.pointer)) {
                pending++;
                continue;
            }
        }
        if (existing && value.action === 'upload') {
            await clearJournal(row.id);
            reconciled++;
            continue;
        }
        if (existing && existing.version !== value.expectedVersion) {
            pending++;
            continue;
        }
        try {
            await removePrivateObject(value.pointer);
            await checkSession();
            await atomic(async () => {
                await checkSession();
                if (existing && value.action === 'delete') await deleteDocument(userId, value.documentId, value.expectedVersion, checkSession);
                await clearJournal(row.id);
            });
            reconciled++;
        }
        catch {
            pending++;
        }
    }
    return { reconciled, pending };
}
export async function saveOriginalShare(value: OriginalShare): Promise<string> {
    const prior = await db().prepare('SELECT * FROM private_context_shares WHERE document_id=? AND user_id=? AND recipient_id=? AND proposal_id=? AND version=? AND expires_at>?')
        .get(value.documentId, value.ownerId, value.recipientId, value.proposalId, value.version, new Date().toISOString()) as ShareRow | undefined;
    if (prior) {
        const previous = decrypt<OriginalShare>(prior.data, `context-share:${prior.id}`);
        if (previous.roomId === value.roomId && previous.proposalDigest === value.proposalDigest && previous.policyDigest === value.policyDigest)
            return prior.id;
    }
    const id = randomUUID();
    await db().prepare('INSERT INTO private_context_shares(id,document_id,user_id,recipient_id,proposal_id,version,expires_at,data) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, value.documentId, value.ownerId, value.recipientId, value.proposalId, value.version, value.expiresAt, encrypt(value, `context-share:${id}`));
    return id;
}
export async function recipientShare(userId: string, id: string): Promise<OriginalShare> {
    const row = await db().prepare('SELECT * FROM private_context_shares WHERE id=? AND recipient_id=? AND expires_at>?').get(id, userId, new Date().toISOString()) as ShareRow | undefined;
    if (!row)
        throw new HttpError(404, 'NOT_FOUND', 'Shared private document was not found.');
    const value = decrypt<OriginalShare>(row.data, `context-share:${id}`);
    if (value.documentId !== row.document_id || value.ownerId !== row.user_id || value.recipientId !== row.recipient_id || value.proposalId !== row.proposal_id || value.version !== row.version || value.expiresAt !== row.expires_at)
        throw new Error('Private document grant is invalid.');
    return value;
}
