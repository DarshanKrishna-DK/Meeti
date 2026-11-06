import { discoveryTick } from '../packages/server/discovery-jobs';
import { closeDatabase } from '../packages/server/db';

let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
console.info('Meeti discovery worker started. Only opted-in active intents are eligible. No publications or automatic introductions are signed.');
while (!stopped) {
  try {
    const result = await discoveryTick();
    if (result.processed || result.failed) console.info(JSON.stringify({ at: new Date().toISOString(), ...result }));
  }
  catch { console.error('Discovery tick failed. No substitute matches were generated.'); }
  // Poll local due work promptly after publication. Persisted job deadlines still enforce
  // the one-minute cadence, account budgets, backoff and exclusive leases before any RPC.
  if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
}
closeDatabase();
