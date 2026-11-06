import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomic, audit, db } from './db';
import { decrypt, encrypt } from './crypto';
import { ai } from './policy';
import { HttpError, requireValue } from './security';
import type { ProfileIntakeResult } from '../agents/src';

type Intake = { text: string; result: ProfileIntakeResult | null; status: 'running' | 'ready' | 'failed'; failureCode?: string };
type Row = { id: string; user_id: string; version: number; data: string; updated_at: string };
export function profileIntakes(userId: string) {
  return (db().prepare('SELECT * FROM profile_intakes WHERE user_id=? ORDER BY updated_at DESC LIMIT 10').all(userId) as Row[])
    .map(row => ({ id: row.id, version: row.version, ...decrypt<Intake>(row.data, `intake:${row.id}`), updatedAt: row.updated_at }));
}
const answerSchema = z.object({ questionId: z.string().uuid(), text: z.string().trim().min(1).max(3000), providerDisclosureConsent: z.literal(true) }).strict();
export const intakeInputSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(8000), providerDisclosureConsent: z.literal(true) }).strict(),
  z.object({ id: z.string().uuid(), version: z.number().int().positive(), answers: z.array(answerSchema).min(1).max(3) }).strict(),
]);
export async function continueIntake(userId: string, body: unknown, checkSession: () => void) {
  const input = intakeInputSchema.parse(body), id = 'id' in input ? input.id : randomUUID();
  const claimed = atomic(() => {
    const row = 'id' in input ? requireValue(db().prepare('SELECT * FROM profile_intakes WHERE id=? AND user_id=?').get(id, userId) as Row | undefined, 'Intake was not found.', 404) : null;
    const previous = row ? decrypt<Intake>(row.data, `intake:${id}`) : null;
    if (row && ('version' in input && row.version !== input.version || previous?.status === 'running')) throw new HttpError(409, 'INTAKE_CHANGED', 'This intake changed or is still processing. Refresh before continuing.');
    if ('id' in input && !previous?.result) throw new HttpError(409, 'INTAKE_UNAVAILABLE', 'Start a new intake after a failed initial request.');
    const value: Intake = { text: 'text' in input ? input.text : previous!.text, result: previous?.result || null, status: 'running' };
    const version = (row?.version || 0) + 1;
    db().prepare('INSERT INTO profile_intakes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at')
      .run(id, userId, version, encrypt(value, `intake:${id}`), new Date().toISOString());
    return { value, version };
  });
  try {
    const result = await ai().continueProfileIntake({ text: claimed.value.text, providerDisclosureConsent: true, maxRounds: 3,
      ...(claimed.value.result ? { priorState: claimed.value.result } : {}), ...('answers' in input ? { answers: input.answers } : {}) });
    checkSession();
    const updated = db().prepare('UPDATE profile_intakes SET data=?,updated_at=? WHERE id=? AND user_id=? AND version=?')
      .run(encrypt({ ...claimed.value, result, status: 'ready' }, `intake:${id}`), new Date().toISOString(), id, userId, claimed.version);
    if (updated.changes !== 1) throw new HttpError(409, 'INTAKE_CHANGED', 'This intake changed while processing.');
    audit(userId, 'profile_intake', 'draft_created', `Private intake ${id}. Owner review is still required.`);
    return { id, version: claimed.version, text: claimed.value.text, result, status: 'ready' };
  } catch (error) {
    db().prepare('UPDATE profile_intakes SET data=?,updated_at=? WHERE id=? AND user_id=? AND version=?')
      .run(encrypt({ ...claimed.value, status: 'failed', failureCode: error instanceof HttpError ? error.code : 'PROVIDER_UNAVAILABLE' }, `intake:${id}`), new Date().toISOString(), id, userId, claimed.version);
    throw error;
  }
}
