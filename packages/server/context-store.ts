import { randomUUID } from 'node:crypto';
import type { ContextDocument } from '../shared/src';
import { atomic, db } from './db';
import { decrypt, encrypt, hash } from './crypto';
import { HttpError } from './security';

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_DOCUMENTS = 5;
export const MAX_TOTAL_DOCUMENT_BYTES = 5 * MAX_DOCUMENT_BYTES;
export const MAX_EXTRACTED_TEXT = 12000;
export const MAX_REVIEWED_EXCERPT = 1200;
export type DocumentRow = { id: string; user_id: string; version: number; size: number; metadata: string; content: string };
export type OriginalShare = { documentId: string; ownerId: string; recipientId: string; proposalId: string; roomId: string;
  version: number; proposalDigest: string; policyDigest: string; expiresAt: string };
type ShareRow = { id: string; document_id: string; user_id: string; recipient_id: string; proposal_id: string; version: number; expires_at: string; data: string };

function documentMetadata(row: DocumentRow): ContextDocument {
  const value = decrypt<ContextDocument>(row.metadata, `context-metadata:${row.user_id}:${row.id}`);
  if (value.id !== row.id || value.version !== row.version || value.size !== row.size) throw new Error('Private document metadata is invalid.');
  return value;
}
export function ownedDocument(userId: string, id: string): { row: DocumentRow; document: ContextDocument } {
  const row = db().prepare('SELECT * FROM private_context_documents WHERE id=? AND user_id=?').get(id, userId) as DocumentRow | undefined;
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Private document was not found.');
  return { row, document: documentMetadata(row) };
}
export function listDocuments(userId: string): ContextDocument[] {
  return (db().prepare('SELECT * FROM private_context_documents WHERE user_id=? ORDER BY id').all(userId) as DocumentRow[]).map(documentMetadata);
}
export function contextFingerprint(userId: string): string {
  const projection = listDocuments(userId).filter(value => value.allowAgentContext && value.reviewedExcerpt.trim())
    .map(value => ({ id: value.id, reviewedExcerpt: value.reviewedExcerpt.trim(), allowAgentContext: true }));
  return projection.length ? hash(JSON.stringify(projection)) : '';
}
/** Return only owner-reviewed reference text. Filenames and extracted previews never enter this projection. */
export function approvedDocumentContext(userId: string): string {
  return listDocuments(userId).filter(value => value.allowAgentContext && value.reviewedExcerpt.trim())
    .map(value => value.reviewedExcerpt.trim()).join('\n\n').slice(0, 1500);
}
export function assertDocumentCapacity(userId: string, size: number): void {
  const usage = db().prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS total FROM private_context_documents WHERE user_id=?').get(userId) as { count: number; total: number };
  if (usage.count >= MAX_DOCUMENTS || usage.total + size > MAX_TOTAL_DOCUMENT_BYTES) {
    throw new HttpError(413, 'DOCUMENT_LIMIT', 'You can keep up to five private documents with a total size of 5 MiB. Delete a document before adding another.');
  }
}
export function createDocument(userId: string, input: Pick<ContextDocument, 'name' | 'mimeType' | 'extractedText' | 'extractionStatus'>, bytes: Uint8Array, checkSession: () => void): ContextDocument {
  return atomic(() => {
    checkSession();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'Private documents must contain between one byte and 1 MiB.');
    assertDocumentCapacity(userId, bytes.byteLength);
    const id = randomUUID(), createdAt = new Date().toISOString();
    const document: ContextDocument = { ...input, extractedText: input.extractedText.slice(0, MAX_EXTRACTED_TEXT), id,
      size: bytes.byteLength, version: 1, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false, createdAt, updatedAt: createdAt };
    db().prepare('INSERT INTO private_context_documents(id,user_id,version,size,metadata,content) VALUES(?,?,?,?,?,?)')
      .run(id, userId, 1, document.size, encrypt(document, `context-metadata:${userId}:${id}`),
        encrypt({ contentBase64: Buffer.from(bytes).toString('base64') }, `context-content:${userId}:${id}`));
    return document;
  });
}
export function assertDocumentVersion(document: ContextDocument, expectedVersion: number): void {
  if (document.version !== expectedVersion) throw new HttpError(409, 'DOCUMENT_CHANGED', 'This private document changed. Refresh and review its current version.');
}
export function updateDocument(userId: string, id: string, input: Pick<ContextDocument, 'reviewedExcerpt' | 'allowAgentContext' | 'allowOriginalShare'> & { expectedVersion: number }, checkSession: () => void): ContextDocument {
  return atomic(() => {
    checkSession();
    const { document } = ownedDocument(userId, id);
    assertDocumentVersion(document, input.expectedVersion);
    if (input.reviewedExcerpt.length > MAX_REVIEWED_EXCERPT || input.reviewedExcerpt.includes('\0')) throw new HttpError(400, 'INVALID_EXCERPT', 'The reviewed excerpt must be plain text of at most 1200 characters.');
    if (input.allowAgentContext && !input.reviewedExcerpt.trim()) throw new HttpError(400, 'EXCERPT_REQUIRED', 'Review and save an excerpt before allowing agent context.');
    if (document.reviewedExcerpt === input.reviewedExcerpt && document.allowAgentContext === input.allowAgentContext && document.allowOriginalShare === input.allowOriginalShare) return document;
    const value: ContextDocument = { ...document, reviewedExcerpt: input.reviewedExcerpt, allowAgentContext: input.allowAgentContext,
      allowOriginalShare: input.allowOriginalShare, version: document.version + 1, updatedAt: new Date().toISOString() };
    db().prepare('UPDATE private_context_documents SET version=?,metadata=? WHERE id=? AND user_id=? AND version=?')
      .run(value.version, encrypt(value, `context-metadata:${userId}:${id}`), id, userId, document.version);
    db().prepare('DELETE FROM private_context_shares WHERE document_id=?').run(id);
    return value;
  });
}
export function deleteDocument(userId: string, id: string, expectedVersion: number, checkSession: () => void): void {
  atomic(() => {
    checkSession();
    const { document } = ownedDocument(userId, id);
    assertDocumentVersion(document, expectedVersion);
    db().prepare('DELETE FROM private_context_documents WHERE id=? AND user_id=? AND version=?').run(id, userId, expectedVersion);
  });
}
export function documentBytes(userId: string, id: string): { document: ContextDocument; bytes: Uint8Array } {
  const { row, document } = ownedDocument(userId, id);
  const content = decrypt<{ contentBase64: string }>(row.content, `context-content:${userId}:${id}`);
  const bytes = Uint8Array.from(Buffer.from(content.contentBase64, 'base64'));
  if (bytes.byteLength !== document.size) throw new Error('Private document content is invalid.');
  return { document, bytes };
}
export function saveOriginalShare(value: OriginalShare): string {
  const prior = db().prepare('SELECT * FROM private_context_shares WHERE document_id=? AND user_id=? AND recipient_id=? AND proposal_id=? AND version=? AND expires_at>?')
    .get(value.documentId, value.ownerId, value.recipientId, value.proposalId, value.version, new Date().toISOString()) as ShareRow | undefined;
  if (prior) {
    const previous = decrypt<OriginalShare>(prior.data, `context-share:${prior.id}`);
    if (previous.roomId === value.roomId && previous.proposalDigest === value.proposalDigest && previous.policyDigest === value.policyDigest) return prior.id;
  }
  const id = randomUUID();
  db().prepare('INSERT INTO private_context_shares(id,document_id,user_id,recipient_id,proposal_id,version,expires_at,data) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, value.documentId, value.ownerId, value.recipientId, value.proposalId, value.version, value.expiresAt, encrypt(value, `context-share:${id}`));
  return id;
}
export function recipientShare(userId: string, id: string): OriginalShare {
  const row = db().prepare('SELECT * FROM private_context_shares WHERE id=? AND recipient_id=? AND expires_at>?').get(id, userId, new Date().toISOString()) as ShareRow | undefined;
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Shared private document was not found.');
  const value = decrypt<OriginalShare>(row.data, `context-share:${id}`);
  if (value.documentId !== row.document_id || value.ownerId !== row.user_id || value.recipientId !== row.recipient_id || value.proposalId !== row.proposal_id || value.version !== row.version || value.expiresAt !== row.expires_at) throw new Error('Private document grant is invalid.');
  return value;
}
