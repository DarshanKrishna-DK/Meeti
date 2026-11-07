import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { route } from '../packages/server/router';
import { discoveryTick } from '../packages/server/discovery-jobs';
import { closeStore, db } from '../packages/server/store';
import { drainAgentTasks } from '../packages/server/agent-tasks';

const maximumBodyBytes = 1410000;
const maximumConcurrentRequests = 16;
const requestDeadlineMs = 180000;
const shutdownDeadlineMs = 25000;
class ApiBoundaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Dependencies = {
  origin: string;
  route: (request: Request, path: string[]) => Promise<Response>;
  discoveryTick: () => Promise<{ processed: number; failed: number }>;
  drainAgentTasks: () => Promise<unknown>;
  closeStore: () => Promise<void>;
  requestDeadlineMs?: number;
  discoveryPollMs?: number;
};

/** Validate hosted configuration without exposing connection strings or enabling a local fallback. */
export function hostedConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const port = Number(environment.PORT || '10000');
  let origin: URL;
  try { origin = new URL(environment.APP_ORIGIN || ''); }
  catch { throw new Error('hosted_origin_invalid'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('hosted_origin_invalid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('hosted_port_invalid');
  if (environment.DATABASE_PROVIDER !== 'postgres' || !environment.SUPABASE_DATABASE_URL) throw new Error('hosted_postgres_required');
  if (environment.AI_ENFORCE_BUDGETS === 'true' && !environment.AI_GLOBAL_BUDGET_ID) throw new Error('hosted_durable_ai_budget_required');
  if (!/^[a-f0-9]{64}$/i.test(environment.DATA_ENCRYPTION_KEY || '')) throw new Error('hosted_encryption_key_required');
  if (environment.WORLD_CAPABILITY_ENABLED === 'true') throw new Error('hosted_world_must_remain_paused');
  if (environment.AGENT_TASK_QUEUE_ENABLED !== 'true') throw new Error('hosted_agent_task_queue_required');
  return { port, origin: origin.origin };
}

function readIncomingBody(incoming: IncomingMessage, signal: AbortSignal): Promise<string> {
  if (Number(incoming.headers['content-length']) > maximumBodyBytes) {
    incoming.pause();
    return Promise.reject(new ApiBoundaryError(413, 'BODY_TOO_LARGE', 'The request exceeds the upload limit.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      incoming.off('data', data); incoming.off('end', end); incoming.off('error', failed); incoming.off('aborted', failed);
      signal.removeEventListener('abort', failed);
    };
    const failed = () => { cleanup(); reject(new ApiBoundaryError(499, 'REQUEST_CLOSED', 'The request connection closed.')); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const data = (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > maximumBodyBytes) {
        incoming.pause(); cleanup(); reject(new ApiBoundaryError(413, 'BODY_TOO_LARGE', 'The request exceeds the upload limit.'));
      } else chunks.push(chunk);
    };
    incoming.on('data', data); incoming.once('end', end); incoming.once('error', failed); incoming.once('aborted', failed);
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
}
function requestHeaders(incoming: IncomingMessage, origin: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || ['host', 'connection', 'transfer-encoding', 'forwarded'].includes(name) || name.startsWith('x-forwarded-')) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  // The Origin header remains the actual caller value. A forged Host cannot change SIWE binding.
  headers.set('host', new URL(origin).host);
  return headers;
}
async function writeResponse(outgoing: ServerResponse, response: Response) {
  if (outgoing.destroyed || outgoing.writableEnded) return;
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== 'set-cookie' && name !== 'transfer-encoding') outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  outgoing.setHeader('X-Content-Type-Options', 'nosniff');
  outgoing.setHeader('Referrer-Policy', 'same-origin');
  outgoing.setHeader('X-Frame-Options', 'DENY');
  const body = Buffer.from(await response.arrayBuffer());
  await new Promise<void>((resolve, reject) => {
    outgoing.once('error', reject);
    outgoing.end(body, () => { outgoing.off('error', reject); resolve(); });
  });
}
function errorResponse(error: unknown) {
  const value = error instanceof ApiBoundaryError ? error : new ApiBoundaryError(503, 'API_UNAVAILABLE', 'The request could not be completed. Refresh the current state before retrying.');
  return Response.json({ error: { code: value.code, message: value.message } }, {
    status: value.status, headers: { 'Cache-Control': 'no-store', Connection: 'close', ...([429, 503, 504].includes(value.status) ? { 'Retry-After': '30' } : {}) },
  });
}

/** A single API process. Database leases enforce cadence; no keep-alive traffic defeats free-tier sleep. */
export function createHostedApi(dependencies: Dependencies) {
  const origin = new URL(dependencies.origin).origin;
  const deadlineMs = dependencies.requestDeadlineMs ?? requestDeadlineMs;
  const pollMs = dependencies.discoveryPollMs ?? 1000;
  if (deadlineMs < 10 || deadlineMs > requestDeadlineMs || pollMs < 10 || pollMs > 60000) throw new Error('hosted_runtime_bounds_invalid');
  const active = new Set<{ controller: AbortController; work: Promise<Response> }>();
  let stopping = false, tick: Promise<void> | undefined, taskTick: Promise<void> | undefined, interval: NodeJS.Timeout | undefined, shutdownPromise: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 20000 }, async (incoming, outgoing) => {
    if (stopping || active.size >= maximumConcurrentRequests) { await writeResponse(outgoing, errorResponse(new ApiBoundaryError(503, 'API_BUSY', 'The service is busy. Retry shortly.'))); return; }
    const controller = new AbortController();
    outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort(); });
    const work = (async () => {
      const rawPath = incoming.url || '';
      if (!rawPath.startsWith('/') || rawPath.startsWith('//')) throw new ApiBoundaryError(400, 'INVALID_PATH', 'Use an application API path.');
      const url = new URL(rawPath, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw new ApiBoundaryError(404, 'NOT_FOUND', 'The API endpoint was not found.');
      if (!['GET', 'POST'].includes(incoming.method || '')) throw new ApiBoundaryError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for this API.');
      if (incoming.method === 'POST' && incoming.headers.origin !== origin) throw new ApiBoundaryError(403, 'ORIGIN_DENIED', 'Use the configured application origin.');
      let path: string[];
      try { path = url.pathname.slice(5).split('/').map(value => decodeURIComponent(value)); }
      catch { throw new ApiBoundaryError(400, 'INVALID_PATH', 'The API path is invalid.'); }
      if (path.some(value => !value || /[\/\\\0]/.test(value))) throw new ApiBoundaryError(400, 'INVALID_PATH', 'The API path is invalid.');
      const body = incoming.method === 'POST' ? await readIncomingBody(incoming, controller.signal) : undefined;
      const request = new Request(url, { method: incoming.method, headers: requestHeaders(incoming, origin), signal: controller.signal, ...(body !== undefined ? { body } : {}) });
      return dependencies.route(request, path);
    })();
    const operation = { controller, work }; active.add(operation);
    void work.then(() => active.delete(operation), () => active.delete(operation));
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(new ApiBoundaryError(504, 'REQUEST_TIMEOUT', 'The request did not finish in time. Refresh the current state before retrying; no successful outcome was assumed.'));
        controller.abort();
      }, deadlineMs); });
      await writeResponse(outgoing, await Promise.race([work, deadline]));
    } catch (error) {
      if (!(error instanceof ApiBoundaryError)) console.error('hosted_request_failed');
      if (!outgoing.headersSent) await writeResponse(outgoing, errorResponse(error));
      else outgoing.destroy();
    } finally {
      clearTimeout(timer);
      // Let the error response flush before closing. Discard remaining bytes without buffering.
      if (!incoming.complete) incoming.resume();
    }
  });
  server.maxHeadersCount = 100;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  server.once('listening', () => {
    interval = setInterval(() => {
      if (stopping) return;
      if (!tick) tick = Promise.resolve().then(() => dependencies.discoveryTick()).then(() => {}, () => { console.error('hosted_discovery_tick_failed'); }).finally(() => { tick = undefined; });
      if (!taskTick) taskTick = Promise.resolve().then(() => dependencies.drainAgentTasks()).then(() => {}, () => { console.error('hosted_agent_task_tick_failed'); }).finally(() => { taskTick = undefined; });
    }, pollMs);
  });
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopping = true; clearInterval(interval);
    shutdownPromise = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>(resolve => { timer = setTimeout(() => {
        for (const operation of active) operation.controller.abort();
        server.closeAllConnections(); resolve();
      }, shutdownDeadlineMs); });
      await Promise.race([Promise.allSettled([closed, ...[...active].map(value => value.work), ...(tick ? [tick] : []), ...(taskTick ? [taskTick] : [])]), deadline]);
      clearTimeout(timer);
      await dependencies.closeStore();
    })();
    return shutdownPromise;
  }
  return { server, shutdown };
}

export async function startHostedApi() {
  const configuration = hostedConfiguration();
  await db().prepare('SELECT 1 AS ready').get();
  const hosted = createHostedApi({ origin: configuration.origin, route, discoveryTick, drainAgentTasks, closeStore });
  await new Promise<void>((resolve, reject) => {
    hosted.server.once('error', reject);
    hosted.server.listen(configuration.port, '0.0.0.0', resolve);
  });
  console.info('Meeti API started. Postgres is configured; integration outcomes require their own live checks. Free hosting discovery runs only while the service is awake.');
  return hosted;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHostedApi().then(hosted => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      const deadline = setTimeout(() => { console.error('hosted_shutdown_deadline'); process.exit(1); }, shutdownDeadlineMs + 3000);
      void hosted.shutdown().then(() => { clearTimeout(deadline); process.exit(0); }, () => { clearTimeout(deadline); console.error('hosted_shutdown_failed'); process.exit(1); });
    });
  }, () => { console.error('hosted_startup_failed'); process.exitCode = 1; });
}
