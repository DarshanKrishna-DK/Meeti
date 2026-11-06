import { db, agent, profile, intent } from './db';
import { decrypt, hash } from './crypto';
import type { AgentParticipant, InferenceReservation, QualificationCheckpoint, QualificationMessage, QualificationOwnerQuestion, QualificationResult } from '../agents/src';
import type { ProposalData } from './db';
import type { Policy } from '../shared/src';
import { privateSnapshotDigest } from './context-policy';

export type QualificationAnswer = { questionId: string; userId: string; ownerAgentId: string; fieldId: string; text: string; fieldClass: 'bio' | 'seeking' | 'offering'; answeredAt: string; providerDisclosureConsent: true; shareWithCounterpart: true };
export type QualificationData = { snapshot: ProposalData; result: QualificationResult | null; messages: QualificationMessage[]; questions: QualificationOwnerQuestion[]; answers: QualificationAnswer[]; proposalId?: string; failureCode?: string;
  checkpoint?: QualificationCheckpoint; attempts?: InferenceReservation[]; retryable?: boolean };
export type QualificationRow = { id: string; left_user: string; right_user: string; pair_key: string; state: string; version: number; data: string; lease_token: string | null; lease_until: string | null; updated_at: string };
export function qualificationRecord(id: string) {
  const row = db().prepare('SELECT * FROM qualifications WHERE id=?').get(id) as QualificationRow | undefined;
  return row ? { row, value: decrypt<QualificationData>(row.data, `qualification:${id}`) } : null;
}
export function answerFieldId(id: string, answer: Pick<QualificationAnswer, 'questionId' | 'text' | 'fieldClass' | 'userId'>) {
  return `qualificationAnswer:${hash(JSON.stringify({ id, questionId: answer.questionId, userId: answer.userId, fieldClass: answer.fieldClass, text: answer.text }))}`;
}
export function qualificationAnswerAllowed(userId: string, otherUserId: string, fieldId: string, policy: Policy): boolean {
  if (!fieldId.startsWith('qualificationAnswer:') || !profile(userId).aiConsent) return false;
  const rows = db().prepare("SELECT id FROM qualifications WHERE state='running' AND ((left_user=? AND right_user=?) OR (left_user=? AND right_user=?))").all(userId, otherUserId, otherUserId, userId) as { id: string }[];
  return rows.some(({ id }) => {
    const record = qualificationRecord(id)!;
    if (!record.row.lease_until || Date.parse(record.row.lease_until) <= Date.now()) return false;
    for (const boundSide of ['left', 'right'] as const) {
      const boundOwner = boundSide === 'left' ? record.row.left_user : record.row.right_user;
      const boundAgent = agent(boundOwner), boundIntent = intent(record.value.snapshot[`${boundSide}Intent`].id);
      if (!boundAgent || boundAgent.id !== record.value.snapshot[`${boundSide}Agent`] || boundAgent.policy.version !== record.value.snapshot[`${boundSide}Policy`].version
        || boundAgent.policy.paused || Date.parse(boundAgent.policy.expiresAt) <= Date.now()
        || privateSnapshotDigest(boundOwner) !== record.value.snapshot[`${boundSide}ProfileDigest`]
        || !boundIntent || boundIntent.userId !== boundOwner || boundIntent.value.version !== record.value.snapshot[`${boundSide}Intent`].version
        || boundIntent.value.status !== 'published' || Date.parse(boundIntent.value.expiresAt) <= Date.now()) return false;
    }
    const side = record.row.left_user === userId ? 'left' : 'right';
    const value = record.value.snapshot;
    if (privateSnapshotDigest(userId) !== value[`${side}ProfileDigest`]) return false;
    const currentIntent = intent(value[`${side}Intent`].id), currentAgent = agent(userId);
    if (!currentAgent || !currentIntent || currentIntent.userId !== userId || currentIntent.value.version !== value[`${side}Intent`].version || currentIntent.value.status !== 'published' || Date.parse(currentIntent.value.expiresAt) <= Date.now()) return false;
    return record.value.answers.some(answer => answer.fieldId === fieldId && answer.userId === userId && answer.ownerAgentId === currentAgent.id
      && answer.providerDisclosureConsent && answer.shareWithCounterpart && policy.allowedFields.includes(answer.fieldClass)
      && answerFieldId(id, { questionId: answer.questionId, text: answer.text, fieldClass: answer.fieldClass, userId }) === fieldId);
  });
}
export function qualificationFields(id: string, userId: string): AgentParticipant['fields'] {
  const record = qualificationRecord(id);
  if (!record) return [];
  return record.value.answers.filter(answer => answer.userId === userId).map(answer => ({ id: answer.fieldId,
    label: `Owner answer about ${answer.fieldClass}; untrusted claimed context`, value: answer.text, visibility: 'private', providerAllowed: true }));
}
