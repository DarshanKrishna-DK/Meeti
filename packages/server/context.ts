import { z } from 'zod';
import type { ContextDocument } from '../shared/src';
import { atomic, audit, db } from './db';
import { checkOrigin, HttpError, rateLimit, requireUser } from './security';
import { assertDocumentCapacity, assertDocumentVersion, createStoredDocument, deleteStoredDocument, loadDocumentBytes, listDocuments, reconcilePrivateObjects,
  MAX_DOCUMENT_BYTES, MAX_EXTRACTED_TEXT, MAX_REVIEWED_EXCERPT, ownedDocument, recipientShare, saveOriginalShare, updateDocument } from './context-store';
import { extractPrivatePdf } from './pdf-extraction';
import { authority, policyDigest } from './policy';
import { assertPair, ownedProposal, requireBothConsents, requireWorld, roomAccess } from './proposals';
import { requireWorldCapability } from './capabilities';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const uploadSchema = z.object({ name: z.string().min(1).max(160),
  mimeType: z.enum(['application/pdf', 'text/plain', 'text/markdown']),
  contentBase64: z.string().min(4).max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) }).strict();
function ok(data: unknown): Response {
  return Response.json({ data }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function decodeUpload(input: z.infer<typeof uploadSchema>): { bytes: Uint8Array; text?: string } {
  if (!input.name.isWellFormed() || input.name !== input.name.trim() || /[\x00-\x1f\x7f/\\:]/.test(input.name) || input.name.startsWith('.')) {
    throw new HttpError(400, 'INVALID_FILENAME', 'Use a plain filename without folders or control characters.');
  }
  const extension = input.name.slice(input.name.lastIndexOf('.')).toLowerCase();
  const expected = input.mimeType === 'application/pdf' ? ['.pdf'] : input.mimeType === 'text/plain' ? ['.txt'] : ['.md', '.markdown'];
  if (!expected.includes(extension)) throw new HttpError(415, 'UNSUPPORTED_DOCUMENT', 'Choose a PDF, UTF-8 text file, or Markdown file with its matching file type.');
  if (input.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64)) {
    throw new HttpError(400, 'INVALID_BASE64', 'The document encoding is invalid.');
  }
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.toString('base64') !== input.contentBase64) throw new HttpError(400, 'INVALID_BASE64', 'The document encoding is invalid.');
  if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'Private documents must contain between one byte and 1 MiB.');
  if (input.mimeType === 'application/pdf') {
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n\t ]/.test(bytes.subarray(0, 16).toString('ascii')) || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) {
      throw new HttpError(415, 'INVALID_PDF', 'The file does not contain a supported PDF header and ending.');
    }
    return { bytes };
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError(415, 'INVALID_TEXT', 'Text and Markdown files must use valid UTF-8 encoding.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /^\s*(?:#!|%PDF-|MZ|\x7fELF)/.test(text)
    || /<\s*\/?\s*(?:!doctype\s+html|html|head|body|script|style|iframe|object|embed|svg|div|span|p|a|img|meta|link|title|table|form|input|button|textarea|section|article|header|footer|video|audio|br|h[1-6]|ul|ol|li)(?:\s|>|\/)/i.test(text)) {
    throw new HttpError(415, 'INVALID_TEXT', 'HTML, executable content, and binary data are not supported as private text documents.');
  }
  return { bytes, text };
}
function attachment(document: ContextDocument, bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { headers: { 'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename="private-document${document.mimeType === 'application/pdf' ? '.pdf' : document.mimeType === 'text/plain' ? '.txt' : '.md'}"; filename*=UTF-8''${encodeURIComponent(document.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' } });
}
function assertOriginalAllowed(document: ContextDocument): void {
  if (!document.allowOriginalShare) throw new HttpError(403, 'ORIGINAL_SHARE_DENIED', 'The owner has not allowed sharing this original file.');
}
function assertContextField(value: Awaited<ReturnType<typeof authority>>): void {
  if (!value.policy.allowedFields.includes('documentContext')) throw new HttpError(403, 'DOCUMENT_POLICY_DENIED', 'Current ENS permissions do not allow document context disclosure.');
}
function checkPairForRelease(p: ReturnType<typeof ownedProposal>): void {
  assertPair(p);
  requireBothConsents(p);
  requireWorld(p.row.id);
}
export async function handleContext(request: Request, key: string, body?: unknown): Promise<Response | null> {
  if (!key.startsWith('context/')) return null;
  const actor = requireUser(request);
  const checkSession = () => {
    if (requireUser(request).id !== actor.id) throw new HttpError(403, 'ACCOUNT_CHANGED', 'The authenticated account changed. Review the document again.');
  };
  if (request.method === 'GET') {
    if (key === 'context/files') return ok(listDocuments(actor.id));
    const download = /^context\/files\/([a-f0-9-]{36})\/download$/.exec(key);
    if (download) { const value = await loadDocumentBytes(actor.id, download[1], checkSession); return attachment(value.document, value.bytes); }
    const shared = /^context\/shared\/([a-f0-9-]{36})$/.exec(key);
    if (shared) {
      const grant = recipientShare(actor.id, shared[1]);
      requireWorldCapability();
      const initialAccess = await roomAccess(actor.id, grant.roomId);
      const initialOwner = await authority(grant.ownerId, 'message'); assertContextField(initialOwner);
      checkPairForRelease(initialAccess.p); recipientShare(actor.id, shared[1]);
      if (grant.proposalDigest !== initialAccess.p.row.digest || grant.proposalId !== initialAccess.p.row.id
        || grant.policyDigest !== policyDigest(initialOwner.policy) || ![initialAccess.p.row.left_user, initialAccess.p.row.right_user].includes(grant.ownerId)
        || grant.ownerId === actor.id) throw new HttpError(403, 'DOCUMENT_GRANT_CHANGED', 'This document grant no longer matches the protected introduction.');
      const initialDocument = ownedDocument(grant.ownerId, grant.documentId).document;
      assertDocumentVersion(initialDocument, grant.version); assertOriginalAllowed(initialDocument);
      const value = await loadDocumentBytes(grant.ownerId, grant.documentId, checkSession);
      // Fetching ciphertext is not permission to release it. Recheck every protected gate after the await.
      const access = await roomAccess(actor.id, grant.roomId);
      const owner = await authority(grant.ownerId, 'message');
      checkSession();
      return atomic(() => {
        checkSession();
        checkPairForRelease(access.p);
        const currentGrant = recipientShare(actor.id, shared[1]);
        if (currentGrant.proposalDigest !== access.p.row.digest || currentGrant.proposalId !== access.p.row.id
          || policyDigest(owner.policy) !== currentGrant.policyDigest || ![access.p.row.left_user, access.p.row.right_user].includes(grant.ownerId)
          || grant.ownerId === actor.id) throw new HttpError(403, 'DOCUMENT_GRANT_CHANGED', 'This document grant no longer matches the protected introduction.');
        assertContextField(owner);
        assertDocumentVersion(ownedDocument(grant.ownerId, grant.documentId).document, value.document.version);
        assertDocumentVersion(value.document, grant.version);
        assertOriginalAllowed(value.document);
        audit(actor.id, 'private_document', 'shared_download', 'Downloaded one explicitly granted original through a protected introduction.');
        return attachment(value.document, value.bytes);
      });
    }
    throw new HttpError(404, 'NOT_FOUND', 'This private document endpoint was not found.');
  }
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
  checkOrigin(request);
  rateLimit(`private-context:${actor.id}`, 30);
  if (key === 'context/files') {
    rateLimit(`private-context-upload:${actor.id}`, 8);
    const input = uploadSchema.parse(body);
    const decoded = decodeUpload(input);
    assertDocumentCapacity(actor.id, decoded.bytes.byteLength);
    const extraction = input.mimeType === 'application/pdf' ? await extractPrivatePdf(decoded.bytes)
      : { extractionStatus: decoded.text?.trim() ? 'ready' as const : 'no-text' as const, extractedText: decoded.text?.slice(0, MAX_EXTRACTED_TEXT) || '' };
    checkSession();
    const document = await createStoredDocument(actor.id, { name: input.name, mimeType: input.mimeType, ...extraction }, decoded.bytes, checkSession);
    audit(actor.id, 'private_document', 'created', 'Stored an encrypted private original and a bounded extracted preview. Agent context and original sharing remain disabled.');
    return ok(document);
  }
  if (key === 'context/files/reconcile') {
    z.object({}).strict().parse(body);
    rateLimit(`private-context-reconcile:${actor.id}`, 3, 60000);
    return ok(await reconcilePrivateObjects(actor.id, checkSession));
  }
  const match = /^context\/files\/([a-f0-9-]{36})\/(update|delete|share)$/.exec(key);
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'This private document endpoint was not found.');
  const [, id, action] = match;
  if (action === 'update') {
    const input = z.object({ expectedVersion: versionSchema, reviewedExcerpt: z.string().max(MAX_REVIEWED_EXCERPT),
      allowAgentContext: z.boolean(), allowOriginalShare: z.boolean() }).strict().parse(body);
    const document = updateDocument(actor.id, id, input, checkSession);
    audit(actor.id, 'private_document', 'updated', 'Updated private document review and sharing permissions. Existing original grants were invalidated when the version changed.');
    return ok(document);
  }
  if (action === 'delete') {
    const input = z.object({ expectedVersion: versionSchema }).strict().parse(body);
    await deleteStoredDocument(actor.id, id, input.expectedVersion, checkSession);
    audit(actor.id, 'private_document', 'deleted', 'Deleted an encrypted private document and its original sharing grants.');
    return ok({ deleted: true });
  }
  const input = z.object({ expectedVersion: versionSchema, proposalId: z.string().uuid() }).strict().parse(body);
  const initial = ownedDocument(actor.id, id).document;
  assertDocumentVersion(initial, input.expectedVersion);
  assertOriginalAllowed(initial);
  const p = ownedProposal(actor.id, input.proposalId);
  requireWorldCapability();
  const room = db().prepare('SELECT id FROM rooms WHERE proposal_id=?').get(p.row.id) as { id: string } | undefined;
  if (!room) throw new HttpError(409, 'ROOM_REQUIRED', 'Open the protected mutual introduction room before sharing an original file.');
  const access = await roomAccess(actor.id, room.id);
  const owner = await authority(actor.id, 'message');
  checkSession();
  return atomic(() => {
    checkPairForRelease(access.p);
    assertContextField(owner);
    const current = ownedDocument(actor.id, id).document;
    assertDocumentVersion(current, input.expectedVersion);
    assertOriginalAllowed(current);
    const expiresAt = new Date(Math.min(Date.now() + 15 * 60000, Date.parse(access.p.value.leftIntent.expiresAt),
      Date.parse(access.p.value.rightIntent.expiresAt), Date.parse(access.p.value.leftPolicy.expiresAt), Date.parse(access.p.value.rightPolicy.expiresAt))).toISOString();
    const grantId = saveOriginalShare({ documentId: id, ownerId: actor.id, recipientId: access.p.row.left_user === actor.id ? access.p.row.right_user : access.p.row.left_user,
      proposalId: access.p.row.id, roomId: room.id, version: current.version, proposalDigest: access.p.row.digest,
      policyDigest: policyDigest(owner.policy), expiresAt });
    audit(actor.id, 'private_document', 'original_granted', 'Granted one version of an original to the current protected room counterpart for at most 15 minutes.');
    return ok({ id: grantId, url: `/api/context/shared/${grantId}`, documentId: id, version: current.version, proposalId: access.p.row.id,
      expiresAt: recipientShare(access.p.row.left_user === actor.id ? access.p.row.right_user : access.p.row.left_user, grantId).expiresAt });
  });
}
