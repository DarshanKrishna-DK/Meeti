import { z } from 'zod';
import { agent, db, profile, type IntentRow } from './db';
import { decrypt } from './crypto';
import { checkOrigin, HttpError, rateLimit, requireUser } from './security';
import type { Intent, OnboardingState } from '../shared/src';

/** Derive setup progress from the current owner records, independently of tour dismissal. */
export function onboardingState(userId: string): OnboardingState {
  const value = profile(userId), currentAgent = agent(userId);
  const preferences = db().prepare('SELECT tour_completed FROM user_preferences WHERE user_id=?').get(userId) as { tour_completed: number } | undefined;
  const intents = (db().prepare('SELECT * FROM intents WHERE user_id=?').all(userId) as IntentRow[])
    .map(row => decrypt<Intent>(row.data, `intent:${row.id}`));
  const profileComplete = Boolean(value.displayName.trim() && value.seeking.trim() && value.offering.trim());
  const hasAgent = currentAgent !== null;
  const hasIntent = intents.some(intent => intent.status !== 'revoked' && intent.status !== 'expired' && Date.parse(intent.expiresAt) > Date.now());
  const hasPublishedIntent = intents.some(intent => intent.status === 'published' && Date.parse(intent.expiresAt) > Date.now());
  return { profileComplete, tourCompleted: preferences?.tour_completed === 1, hasAgent, hasIntent, hasPublishedIntent };
}

export function handleOnboarding(request: Request, key: string, body?: unknown): Response | null {
  if (key !== 'onboarding') return null;
  const actor = requireUser(request);
  if (request.method === 'POST') {
    checkOrigin(request);
    rateLimit(`onboarding:${actor.id}`, 120);
    const input = z.object({ tourCompleted: z.boolean() }).strict().parse(body);
    db().prepare('INSERT INTO user_preferences(user_id,tour_completed,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET tour_completed=excluded.tour_completed,updated_at=excluded.updated_at')
      .run(actor.id, input.tourCompleted ? 1 : 0, new Date().toISOString());
  } else if (request.method !== 'GET') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for onboarding preferences.');
  }
  return Response.json({ data: onboardingState(actor.id) }, { headers: { 'Cache-Control': 'no-store' } });
}
