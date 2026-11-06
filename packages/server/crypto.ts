import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

function key(): Buffer {
  const value = process.env.DATA_ENCRYPTION_KEY;
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new Error('Configure DATA_ENCRYPTION_KEY by running npm run setup.');
  return Buffer.from(value, 'hex');
}
export function encrypt(value: unknown, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function decrypt<T>(value: string, context: string): T {
  const [version, iv, tag, body] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Encrypted record is invalid.');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8')) as T;
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function sign(value: string): string { return createHmac('sha256', key()).update(value).digest('hex'); }
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected || '', 'hex');
  return target.length === actual.length && timingSafeEqual(actual, target);
}
