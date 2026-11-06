import { createClient } from '@supabase/supabase-js';
import { HttpError } from './security';

export const PRIVATE_CONTEXT_BUCKET = 'meeti-context';
export const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
export type PrivateObject = { storage: 'supabase'; bucket: typeof PRIVATE_CONTEXT_BUCKET; path: string; cipherDigest: string; cipherBytes: number };
export function privateStorageEnabled(): boolean { return process.env.SUPABASE_STORAGE_ENABLED === 'true'; }
function storageClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, 'PRIVATE_STORAGE_UNCONFIGURED', 'Private cloud storage is not configured.');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new HttpError(503, 'PRIVATE_STORAGE_UNCONFIGURED', 'Private cloud storage requires its HTTPS project endpoint.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])]);
    const response = await fetch(input, { ...init, signal });
    if (response.ok && (!init?.method || init.method === 'GET') && String(input).includes('/storage/v1/object/')) {
      if (Number(response.headers.get('content-length')) > MAX_CIPHERTEXT_BYTES) { await response.body?.cancel(); throw new Error('Private object exceeds its size bound.'); }
      const reader = response.body?.getReader(); if (!reader) return response;
      let length = 0; const chunks: Uint8Array[] = [];
      for (;;) { const value = await reader.read(); if (value.done) break; length += value.value.byteLength;
        if (length > MAX_CIPHERTEXT_BYTES) { await reader.cancel(); throw new Error('Private object exceeds its size bound.'); } chunks.push(value.value); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    }
    return response;
  } } });
}
function validBucket(bucket: { public: boolean; file_size_limit?: number | null; allowed_mime_types?: string[] | null }) {
  if (bucket.public || !bucket.file_size_limit || bucket.file_size_limit > MAX_CIPHERTEXT_BYTES || bucket.allowed_mime_types?.length !== 1 || bucket.allowed_mime_types[0] !== 'application/octet-stream') {
    throw new HttpError(503, 'PRIVATE_BUCKET_UNSAFE', 'The private document bucket does not meet its privacy and size requirements.');
  }
}
export async function checkPrivateStorage() {
  try {
    const { data, error } = await storageClient().storage.getBucket(PRIVATE_CONTEXT_BUCKET);
    if (error || !data) throw new Error('Bucket unavailable.'); validBucket(data);
    return { bucket: PRIVATE_CONTEXT_BUCKET, private: true, encryptedOriginals: true, maximumCiphertextBytes: MAX_CIPHERTEXT_BYTES };
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'PRIVATE_STORAGE_UNAVAILABLE', 'Private cloud storage could not be verified.'); }
}
export async function bootstrapPrivateContextBucket() {
  const client = storageClient();
  const existing = await client.storage.getBucket(PRIVATE_CONTEXT_BUCKET);
  if (!existing.data) {
    const created = await client.storage.createBucket(PRIVATE_CONTEXT_BUCKET, { public: false, fileSizeLimit: MAX_CIPHERTEXT_BYTES, allowedMimeTypes: ['application/octet-stream'] });
    if (created.error) return checkPrivateStorage();
  }
  return checkPrivateStorage();
}
export function validatePrivateObject(value: PrivateObject): void {
  if (value.storage !== 'supabase' || value.bucket !== PRIVATE_CONTEXT_BUCKET || !/^[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(value.path)
    || !/^[a-f0-9]{64}$/.test(value.cipherDigest) || !Number.isSafeInteger(value.cipherBytes) || value.cipherBytes < 1 || value.cipherBytes > MAX_CIPHERTEXT_BYTES) throw new HttpError(503, 'PRIVATE_OBJECT_INVALID', 'The encrypted private object reference is invalid.');
}
export async function uploadPrivateObject(value: PrivateObject, ciphertext: string): Promise<void> {
  validatePrivateObject(value);
  if (Buffer.byteLength(ciphertext) !== value.cipherBytes) throw new HttpError(503, 'PRIVATE_OBJECT_INVALID', 'The encrypted private object size is invalid.');
  try {
    await checkPrivateStorage();
    const { error } = await storageClient().storage.from(PRIVATE_CONTEXT_BUCKET).upload(value.path, Buffer.from(ciphertext), { contentType: 'application/octet-stream', upsert: false, cacheControl: '0' });
    if (error) throw new Error('Upload rejected.');
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'PRIVATE_UPLOAD_FAILED', 'Private cloud upload did not complete. Retry after storage recovers.'); }
}
export async function downloadPrivateObject(value: PrivateObject): Promise<string> {
  validatePrivateObject(value);
  try {
    await checkPrivateStorage();
    const { data, error } = await storageClient().storage.from(PRIVATE_CONTEXT_BUCKET).download(value.path);
    if (error || !data || data.size !== value.cipherBytes || data.size > MAX_CIPHERTEXT_BYTES) throw new Error('Object unavailable.');
    return await data.text();
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'PRIVATE_DOWNLOAD_FAILED', 'The encrypted private original could not be retrieved.'); }
}
export async function removePrivateObject(value: PrivateObject): Promise<void> {
  validatePrivateObject(value);
  try { const { error } = await storageClient().storage.from(PRIVATE_CONTEXT_BUCKET).remove([value.path]); if (error) throw new Error('Delete rejected.'); }
  catch { throw new HttpError(503, 'PRIVATE_DELETE_FAILED', 'Private cloud deletion is pending. Retry after storage recovers.'); }
}
