import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
if (existsSync('.env.local')) {
  console.log('.env.local already exists. Existing configuration was preserved.');
} else {
  const template = readFileSync('.env.example', 'utf8');
  writeFileSync('.env.local', template.replace('DATA_ENCRYPTION_KEY=', `DATA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`), { mode: 0o600 });
  console.log('Created local configuration with a random data encryption key. No provider credentials configured.');
}
mkdirSync('.local-data', { recursive: true });
