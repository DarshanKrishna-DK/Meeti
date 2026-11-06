import { randomUUID } from 'node:crypto';
import { db } from '../packages/server/db';
import { encrypt, hashPassword } from '../packages/server/crypto';
import type { Profile } from '../packages/shared/src';
if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SEED !== 'true') {
  throw new Error('Synthetic profiles require ALLOW_SYNTHETIC_SEED=true in local development.');
}
const fictional = [
  { email: 'asha@meeti.example', displayName: 'Asha (fictional demo)', headline: 'Building accessible community tools', offering: 'Product design and user research', seeking: 'A technical collaborator for community software', tags: ['community', 'accessibility'] },
  { email: 'kabir@meeti.example', displayName: 'Kabir (fictional demo)', headline: 'Building useful software with people', offering: 'TypeScript and accessible web engineering', seeking: 'A product collaborator for community tools', tags: ['community', 'accessibility'] },
];
for (const record of fictional) {
  if (db().prepare('SELECT id FROM users WHERE email=?').get(record.email)) continue;
  const id = randomUUID();
  const p: Profile = { ...record, bio: 'Clearly fictional local demonstration profile. Review all visibility before publishing.',
    contact: '', employer: '', publicFields: [], aiConsent: false };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, record.email, hashPassword('Meeti-demo-only-2026!'), null, encrypt(p, `profile:${id}`), new Date().toISOString());
}
console.log('Created or preserved two fictional local accounts: asha@meeti.example and kabir@meeti.example.');
console.log('Demo-only password: Meeti-demo-only-2026! No wallet, permission, intent, match, proof or introduction was fabricated.');
