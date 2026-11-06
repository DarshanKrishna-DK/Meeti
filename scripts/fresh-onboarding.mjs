import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Select a new dataset while preserving every previous database and encryption key.
if (!existsSync('.env.local')) throw new Error('Run npm run setup first.');
const configuration = readFileSync('.env.local', 'utf8');
const previous = configuration.match(/^DATABASE_PATH=(.*)$/m)?.[1]?.trim() || '.local-data/meeti.sqlite';
const next = `.local-data/onboarding-${randomUUID()}.sqlite`;
mkdirSync('.local-data', { recursive: true });
const manifest = resolve('.local-data', `onboarding-reset-${Date.now()}.json`);
writeFileSync(manifest, JSON.stringify({ previousDatabasePath: previous, nextDatabasePath: next, createdAt: new Date().toISOString(), instruction: 'Stop the server, restore DATABASE_PATH to previousDatabasePath in .env.local, then restart. Do not change DATA_ENCRYPTION_KEY.' }, null, 2), { mode: 0o600 });
const updated = /^DATABASE_PATH=.*$/m.test(configuration)
  ? configuration.replace(/^DATABASE_PATH=.*$/m, `DATABASE_PATH=${next}`)
  : `${configuration.trimEnd()}\nDATABASE_PATH=${next}\n`;
writeFileSync('.env.local', updated, { mode: 0o600 });
console.log('Selected a fresh private dataset. Restart Meeti to test onboarding. Previous databases and the encryption key were preserved.');
console.log(`Restore instructions: ${manifest}`);
