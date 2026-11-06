import { z } from 'zod';
import { agent, db, profile, type IntentRow } from './store';
import { decrypt } from './crypto';
import { checkOrigin, HttpError, rateLimit, requireUser } from './security';
import type { Intent, OnboardingState } from '../shared/src';

/** Derive setup progress from the current owner records, independently of tour dismissal. */
export async function onboardingState(userId: string): Promise<OnboardingState> {
  const value = await profile(userId), currentAgent = await agent(userId);
  const preferences = await db().prepare('SELECT tour_completed FROM user_preferences WHERE user_id=?').get(userId) as { tour_completed: number } | undefined;
  const intents = (await db().prepare('SELECT * FROM intents WHERE user_id=?').all(userId) as IntentRow[])
    .map(row => decrypt<Intent>(row.data, `intent:${row.id}`));
  const profileComplete = Boolean(value.displayName.trim() && value.seeking.trim() && value.offering.trim());
  const hasAgent = currentAgent !== null;
  const hasIntent = intents.some(intent => intent.status !== 'revoked' && intent.status !== 'expired' && Date.parse(intent.expiresAt) > Date.now());
  const hasPublishedIntent = intents.some(intent => intent.status === 'published' && Date.parse(intent.expiresAt) > Date.now());
  return { profileComplete, tourCompleted: preferences?.tour_completed === 1, hasAgent, hasIntent, hasPublishedIntent };
}

export async function handleOnboarding(request: Request, key: string, body?: unknown): Promise<Response | null> {
  if (key !== 'onboarding') return null;
  const actor = await requireUser(request);
  if (request.method === 'POST') {
    checkOrigin(request);
    await rateLimit(`onboarding:${actor.id}`, 120);
    const input = z.object({ tourCompleted: z.boolean() }).strict().parse(body);
    await db().prepare('INSERT INTO user_preferences(user_id,tour_completed,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET tour_completed=excluded.tour_completed,updated_at=excluded.updated_at')
      .run(actor.id, input.tourCompleted ? 1 : 0, new Date().toISOString());
  } else if (request.method !== 'GET') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for onboarding preferences.');
  }
  return Response.json({ data: await onboardingState(actor.id) }, { headers: { 'Cache-Control': 'no-store' } });
}
