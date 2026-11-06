import { randomBytes } from 'node:crypto';
import { atomic, db, user, type UserRow } from './store';
import { hash } from './crypto';
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?: number) { super(message); }
}
export function requireValue<T>(value: T | null | undefined, message: string, status = 400): T {
  if (value == null) throw new HttpError(status, 'INVALID_REQUEST', message);
  return value;
}
export async function sessionUser(request: Request): Promise<UserRow | null> {
  const tokenHash = sessionTokenHash(request);
  if (!tokenHash) return null;
  const row = await db().prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash, new Date().toISOString()) as { user_id: string } | undefined;
  return row ? await user(row.user_id) || null : null;
}
export function sessionTokenHash(request: Request): string | null {
  const values = request.headers.get('cookie')?.split(';').map(x => x.trim()).filter(x => x.startsWith('meeti_session=')) || [];
  if (values.length !== 1) return null;
  const token = values[0].slice(14);
  return /^[a-f\d]{64}$/.test(token) ? hash(token) : null;
}
export async function requireUser(request: Request): Promise<UserRow> {
  const actor = await sessionUser(request);
  if (!actor) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  return actor;
}
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db().prepare('DELETE FROM sessions WHERE expires_at<?').run(new Date().toISOString());
  await db().prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), userId, new Date(Date.now() + 7 * 86400000).toISOString());
  return `meeti_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function checkOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const allowed = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
  if (origin !== allowed) throw new HttpError(403, 'ORIGIN_DENIED', 'This request must come from the application.');
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Send a JSON request.');
}
export async function rateLimit(bucket: string, maximum: number, windowMs = 60000): Promise<void> {
  const now = Date.now();
  const row = await atomic(async () => {
    await db().prepare('INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END, reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END').run(bucket, now + windowMs, now, now);
    return await db().prepare('SELECT count,reset_at FROM rate_limits WHERE bucket=?').get(bucket) as { count: number; reset_at: number };
  });
  if (row.count > maximum) {
    const seconds = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    throw new HttpError(429, 'RATE_LIMITED', `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`, seconds);
  }
}
export async function readBody(request: Request, maximumBytes = 64000): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maximumBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'A JSON request is required.');
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'The JSON request could not be read.'); }
}
