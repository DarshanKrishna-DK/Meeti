import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
const cwd = process.cwd();
const local = Object.entries(parseEnv(readFileSync('.env.local', 'utf8'))).filter(([key]) => /(?:KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/.test(key));
const secrets = local.flatMap(([key, value]) => {
  if (key.endsWith('DATABASE_URL')) {
    try { return [value, decodeURIComponent(new URL(value).password)]; } catch { return [value]; }
  }
  return [value];
}).filter(value => value.length >= 16);
const files = execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const matches = [];
for (const file of files) {
  if (!statSync(file).isFile()) continue;
  const data = readFileSync(file);
  if (secrets.some(value => data.includes(Buffer.from(value)))) matches.push(file);
}
console.log(JSON.stringify({ checkedFiles: files.length, localSecretMatches: matches }, null, 2));
if (matches.length) process.exitCode = 1;
