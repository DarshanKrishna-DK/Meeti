import { discoveryTick } from '../packages/server/discovery-jobs';
import { closeDatabase } from '../packages/server/db';

let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
console.info('Meeti discovery worker started. Only opted-in active intents are eligible. No publications or automatic introductions are signed.');
while (!stopped) {
  const started = Date.now();
  try { console.info(JSON.stringify({ at: new Date().toISOString(), ...await discoveryTick() })); }
  catch { console.error('Discovery tick failed. No substitute matches were generated.'); }
  const remaining = Math.max(1000, 60000 - (Date.now() - started));
  for (let waited = 0; waited < remaining && !stopped; waited += 1000) await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining - waited)));
}
closeDatabase();
