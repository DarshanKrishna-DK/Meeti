import { randomBytes } from 'node:crypto';
import { db, user, type UserRow } from './db';
import { hash } from './crypto';
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireValue<T>(value: T | null | undefined, message: string, status = 400): T {
  if (value == null) throw new HttpError(status, 'INVALID_REQUEST', message);
  return value;
}
export function sessionUser(request: Request): UserRow | null {
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('meeti_session='))?.slice(14);
  if (!token || !/^[a-f\d]{64}$/.test(token)) return null;
  const row = db().prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), new Date().toISOString()) as { user_id: string } | undefined;
  return row ? user(row.user_id) || null : null;
}
export function requireUser(request: Request): UserRow {
  const actor = sessionUser(request);
  if (!actor) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  return actor;
}
export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  db().prepare('DELETE FROM sessions WHERE expires_at<?').run(new Date().toISOString());
  db().prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), userId, new Date(Date.now() + 7 * 86400000).toISOString());
  return `meeti_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function checkOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const allowed = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
  if (origin !== allowed) throw new HttpError(403, 'ORIGIN_DENIED', 'This request must come from the application.');
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Send a JSON request.');
}
export function rateLimit(bucket: string, maximum: number, windowMs = 60000): void {
  const now = Date.now();
  db().prepare('INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END').run(bucket, now + windowMs, now, now);
  const row = db().prepare('SELECT count FROM rate_limits WHERE bucket=?').get(bucket) as { count: number };
  if (row.count > maximum) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.');
}
export async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 64000) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'A JSON request is required.');
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 64000) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'The JSON request could not be read.'); }
}
