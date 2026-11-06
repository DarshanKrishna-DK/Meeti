import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
const cwd = process.cwd();
const local = readFileSync('.env.local', 'utf8').split(/\r?\n/).filter(line => /^[A-Z0-9_]*(?:KEY|SECRET)[A-Z0-9_]*=/.test(line));
const secrets = local.map(line => line.slice(line.indexOf('=') + 1).trim()).filter(value => value.length >= 16);
const files = execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const matches = [];
for (const file of files) {
  if (!statSync(file).isFile()) continue;
  const data = readFileSync(file);
  if (secrets.some(value => data.includes(Buffer.from(value)))) matches.push(file);
}
console.log(JSON.stringify({ checkedFiles: files.length, localSecretMatches: matches }, null, 2));
if (matches.length) process.exitCode = 1;
