import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { z } from 'zod';
import type { Profile } from '../shared/src';
import { atomic, audit, db } from './db';
import { encrypt, hash, hashPassword } from './crypto';
import { checkOrigin, createSession, HttpError, rateLimit } from './security';

const flowCookieName = 'meeti_wallet_flow';
const challengeSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const verificationSchema = z.object({
  id: z.string().uuid(),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
}).strict();
type ChallengeRow = {
  id: string; address: Address; chain_id: number; origin: string; message: string;
  flow_hash: string; expires_at: string; used: number;
};

function flowCookie(token: string, maxAge: number): string {
  return `${flowCookieName}=${token}; Path=/api/auth/wallet; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function requestFlow(request: Request): string | null {
  const values = request.headers.get('cookie')?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${flowCookieName}=`)) || [];
  if (values.length !== 1) return null;
  const token = values[0].slice(flowCookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function blankProfile(): Profile {
  return { displayName: '', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
}
function response(data: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json({ data }, { headers });
}

/** Authenticate an EOA with its exact EIP-4361 challenge, without chain writes. */
export async function handleWalletAuth(request: Request, key: string, body: unknown): Promise<Response | null> {
  if (key !== 'auth/wallet/challenge' && key !== 'auth/wallet/verify') return null;
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST for wallet sign-in.');
  checkOrigin(request);
  const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
  if (key === 'auth/wallet/challenge') {
    const input = challengeSchema.parse(body);
    let address: Address;
    try { address = getAddress(input.address); }
    catch { throw new HttpError(400, 'INVALID_WALLET', 'Choose a valid Ethereum wallet address.'); }
    rateLimit('wallet-auth:challenge:global', 60);
    rateLimit(`wallet-auth:challenge:${address.toLowerCase()}`, 10);
    const id = randomUUID(), flow = randomBytes(32).toString('hex');
    const issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + 300000);
    const message = createSiweMessage({
      address, chainId: input.chainId, domain: new URL(origin).host, uri: origin,
      version: '1', nonce: randomBytes(32).toString('hex'), issuedAt, expirationTime, requestId: id,
      statement: 'Sign in to Meeti. This signature does not authorize transactions or public disclosure.',
    });
    db().prepare('DELETE FROM wallet_auth_challenges WHERE expires_at<=?').run(issuedAt.toISOString());
    db().prepare('INSERT INTO wallet_auth_challenges(id,address,chain_id,origin,message,flow_hash,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, address.toLowerCase(), input.chainId, origin, message, hash(flow), expirationTime.toISOString());
    return response({ id, message, address, chainId: input.chainId, expiresAt: expirationTime.toISOString() }, [flowCookie(flow, 300)]);
  }
  const input = verificationSchema.parse(body);
  rateLimit('wallet-auth:verify:global', 120);
  const row = db().prepare('SELECT * FROM wallet_auth_challenges WHERE id=?').get(input.id) as ChallengeRow | undefined;
  if (!row || row.used || Date.parse(row.expires_at) <= Date.now() || row.origin !== origin) {
    throw new HttpError(403, 'CHALLENGE_EXPIRED', 'This wallet sign-in challenge is expired or already used.');
  }
  const flow = requestFlow(request);
  if (!flow || !timingSafeEqual(Buffer.from(hash(flow), 'hex'), Buffer.from(row.flow_hash, 'hex'))) {
    throw new HttpError(403, 'SIGN_IN_FLOW_MISMATCH', 'Start wallet sign-in again in this browser.');
  }
  let valid = false;
  try { valid = await verifyMessage({ address: row.address, message: row.message, signature: input.signature as Hex }); }
  catch { /* Invalid wallet signatures always deny access. */ }
  if (!valid) throw new HttpError(403, 'INVALID_SIGNATURE', 'Wallet ownership could not be verified.');
  const account = atomic(() => {
    const changed = db().prepare('UPDATE wallet_auth_challenges SET used=1 WHERE id=? AND used=0 AND expires_at>? AND origin=?')
      .run(row.id, new Date().toISOString(), origin);
    if (changed.changes !== 1) throw new HttpError(403, 'REPLAY_DENIED', 'This wallet sign-in challenge is expired or already used.');
    let actor = db().prepare('SELECT id FROM users WHERE lower(wallet)=?').get(row.address.toLowerCase()) as { id: string } | undefined;
    if (!actor) {
      actor = { id: randomUUID() };
      // A reserved internal identifier preserves the existing non-null email schema.
      const internalEmail = `${actor.id}@wallet.meeti.invalid`;
      db().prepare('INSERT INTO users(id,email,password_hash,wallet,profile,created_at) VALUES(?,?,?,?,?,?)')
        .run(actor.id, internalEmail, hashPassword(randomBytes(48).toString('hex')), row.address.toLowerCase(), encrypt(blankProfile(), `profile:${actor.id}`), new Date().toISOString());
      audit(actor.id, 'account', 'created', 'Wallet account created with empty private profile defaults.');
    }
    audit(actor.id, 'session', 'created', 'Signed in with verified wallet ownership.');
    return { id: actor.id, cookie: createSession(actor.id) };
  });
  return response({ id: account.id, wallet: row.address, chainId: row.chain_id }, [account.cookie, flowCookie('', 0)]);
}
