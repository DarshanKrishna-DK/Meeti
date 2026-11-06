import { DatabaseSync } from 'node:sqlite';
import { decrypt } from '../packages/server/crypto';
import type { QualificationData } from '../packages/server/qualification-context';

const id = process.argv[2];
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Supply the exact qualification identifier.');
const database = new DatabaseSync('.local-data/demo-core-flow.sqlite', { readOnly: true });
try {
  const row = database.prepare('SELECT state,version,data FROM qualifications WHERE id=?').get(id) as { state: string; version: number; data: string } | undefined;
  if (!row) throw new Error('Qualification is not present.');
  const value = decrypt<QualificationData>(row.data, `qualification:${id}`);
  console.log(JSON.stringify({ id, state: row.state, version: row.version, failureCode: value.failureCode,
    retryable: value.retryable, attempts: value.attempts, acceptedMessageCount: value.messages.length,
    completedInference: value.messages.map(message => message.inference), questionCount: value.questions.length,
    proposalId: value.proposalId ?? null }, null, 2));
} finally { database.close(); }
