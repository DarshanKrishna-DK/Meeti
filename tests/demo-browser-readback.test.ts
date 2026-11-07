import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readbackRequestReason, selectReadbackSessions } from '../scripts/demo-browser-readback';

const local = 'http://127.0.0.1:3173', hosted = 'https://meeti-theta.vercel.app';
function fixture() {
  const accounts = { 'demo-seeker': randomUUID(), 'demo-recruiter': randomUUID() };
  const sessions = { 'demo-seeker': `meeti_session=${randomBytes(32).toString('hex')}`, 'demo-recruiter': `meeti_session=${randomBytes(32).toString('hex')}` };
  const bound = { 'demo-seeker': `meeti_session=${randomBytes(32).toString('hex')}`, 'demo-recruiter': `meeti_session=${randomBytes(32).toString('hex')}` };
  const binding = { accounts, sessions: bound, wallets: { 'demo-seeker': '0x' + randomBytes(20).toString('hex'), 'demo-recruiter': '0x' + randomBytes(20).toString('hex') }, authenticatedAt: new Date().toISOString() };
  return { version: 1 as const, origin: local, accounts, sessions, hostedAuth: { [hosted]: binding, [local]: binding } };
}
describe('read-only hosted browser origin/session guards without browser execution', () => {
  it('selects only exact origin-bound sessions and uses secure cookies for HTTPS', () => {
    const saved = fixture(), selected = selectReadbackSessions(saved, { APP_ORIGIN: hosted, DEMO_AUTH_TARGET_ORIGIN: hosted });
    expect(selected.sessions).toEqual(saved.hostedAuth[hosted].sessions);
    expect(selected.sessions).not.toEqual(saved.sessions); expect(selected.secure).toBe(true);
    expect(saved.origin).toBe(local);
  });
  it('allows explicit local Postgres sessions while preserving legacy local-only inspection', () => {
    const saved = fixture();
    expect(selectReadbackSessions(saved, { APP_ORIGIN: local, DEMO_AUTH_TARGET_ORIGIN: local }).sessions).toEqual(saved.hostedAuth[local].sessions);
    expect(selectReadbackSessions(saved, { APP_ORIGIN: local }).sessions).toEqual(saved.sessions);
  });
  it('never falls back to local cookies for a hosted destination or another account', () => {
    const saved = fixture();
    expect(() => selectReadbackSessions(saved, { APP_ORIGIN: hosted })).toThrow();
    expect(() => selectReadbackSessions(saved, { APP_ORIGIN: hosted, DEMO_AUTH_TARGET_ORIGIN: 'https://other.vercel.app' })).toThrow();
    const missing = { ...saved, hostedAuth: { [local]: saved.hostedAuth[local] } };
    expect(() => selectReadbackSessions(missing, { APP_ORIGIN: hosted, DEMO_AUTH_TARGET_ORIGIN: hosted })).toThrow();
    const mismatched = fixture(); mismatched.hostedAuth[hosted].accounts = { ...mismatched.accounts, 'demo-seeker': randomUUID() };
    expect(() => selectReadbackSessions(mismatched, { APP_ORIGIN: hosted, DEMO_AUTH_TARGET_ORIGIN: hosted })).toThrow();
  });
  it('blocks authentication, mutations, provider checks and task GETs that could advance model work', () => {
    for (const [path, method] of [['/api/auth/wallet/challenge', 'POST'], ['/api/profile', 'POST'], ['/api/agent/check', 'GET'], ['/api/agent-tasks/' + randomUUID(), 'GET'], ['/api/public/agents/fixture.eth/context', 'GET']]) expect(readbackRequestReason(hosted, hosted + path, method)).not.toBe('');
    expect(readbackRequestReason(hosted, hosted + '/api/state', 'GET')).toBe('');
    expect(readbackRequestReason(hosted, hosted + '/profile', 'GET')).toBe('');
    expect(readbackRequestReason(hosted, 'https://external.example/api/state', 'GET')).toBe('external-request-blocked');
  });
});
