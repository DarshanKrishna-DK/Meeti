import { pathToFileURL } from 'node:url';
import { inspectDemoOrigin } from '../packages/server/demo-access';

export async function demoReadiness(env: NodeJS.ProcessEnv = process.env, options: { target?: 'local' | 'vercel' } = {}) {
  const origin = inspectDemoOrigin(env.APP_ORIGIN);
  const checks: { name: string; state: 'ready' | 'blocked' | 'unverified' | 'paused'; detail: string }[] = [
    { name: 'Node runtime', state: Number(process.versions.node.split('.')[0]) >= 24 ? 'ready' : 'blocked', detail: 'Meeti requires Node.js 24 or newer.' },
    { name: 'Canonical origin', state: origin.usable ? 'ready' : 'blocked', detail: origin.reason },
    { name: 'Private storage key', state: /^[a-f\d]{64}$/i.test(env.DATA_ENCRYPTION_KEY || '') ? 'ready' : 'blocked', detail: 'Only key presence and format are checked. The key is never printed.' },
    { name: 'Independent participants', state: 'unverified', detail: 'Use separate browser profiles, a regular and private context, or different devices. Ordinary windows in one profile share login cookies.' },
    { name: 'World verification', state: env.WORLD_CAPABILITY_ENABLED === 'true' ? 'unverified' : 'paused', detail: env.WORLD_CAPABILITY_ENABLED === 'true' ? 'Capability is enabled by configuration. This is not proof of successful verification.' : 'World is disabled. Human verification and protected room release cannot complete.' },
    { name: 'Phone and wallet', state: 'unverified', detail: 'A desktop viewport test does not prove physical-phone access. Android Chrome is suitable for viewing; wallet signing needs an actually available wallet-enabled browser or supported wallet connection.' },
  ];
  const vercel = options.target === 'vercel' || env.VERCEL === '1';
  checks.push({ name: 'Deployment architecture', state: vercel ? 'blocked' : 'unverified', detail: vercel
    ? 'The current application stores SQLite files locally and calls laptop-local Ollama. Deploying this full backend as Vercel serverless would not preserve that architecture. Prepare and verify a durable HTTPS backend or an approved storage and embedding migration before deployment.'
    : 'The current SQLite and laptop-local Ollama backend needs a persistent server. A Vercel frontend by itself does not provide that backend.' });
  if (origin.usable && origin.origin) {
    try {
      const response = await fetch(`${origin.origin}/api/health`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      const health = await response.json() as { data?: { status?: string; integrations?: Record<string, { configured?: boolean; status?: string }> } };
      const reachable = response.ok && health.data?.status === 'ok';
      checks.push({ name: 'Application server', state: reachable ? 'ready' : 'blocked', detail: reachable ? 'The actual health endpoint responded. This does not establish sponsor or end-to-end success.' : 'The health endpoint did not return the expected healthy response.' });
      if (reachable) for (const name of ['ens', 'arkiv', 'ai']) {
        checks.push({ name: `${name.toUpperCase()} configuration`, state: health.data?.integrations?.[name]?.configured ? 'ready' : 'blocked', detail: 'Configuration presence only. Actual authorization, queries and inference must be tested separately.' });
      }
    } catch {
      checks.push({ name: 'Application server', state: 'blocked', detail: 'The configured server could not be reached within eight seconds, or its TLS certificate was not trusted. Start the app and use the exact configured origin.' });
    }
  }
  return {
    kind: 'read-only-demo-readiness', checkedAt: new Date().toISOString(),
    ...(origin.origin ? { origin: origin.origin } : {}),
    checks,
    readyForLocalReview: !checks.some(value => value.state === 'blocked'),
    completeMvpVerified: false,
    notice: 'No account, wallet, provider inference, chain write, World request or device configuration was created by this check.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await demoReadiness(process.env, { target: process.argv.includes('--target=vercel') ? 'vercel' : 'local' });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('Meeti demo readiness');
    if (result.origin) console.log(`Canonical origin: ${result.origin}`);
    for (const check of result.checks) console.log(`[${check.state}] ${check.name}: ${check.detail}`);
    console.log(result.notice);
  }
  if (!result.readyForLocalReview) process.exitCode = 1;
}
