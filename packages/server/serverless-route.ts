import { after } from 'next/server';
import { getDeadline } from '@vercel/functions';
import { route as applicationRoute } from './router';
import { requireUser } from './security';
import { drainAgentTasks } from './agent-tasks';
import { discoveryTick } from './discovery-jobs';

type Dependencies = {
  route: typeof applicationRoute;
  user: typeof requireUser;
  schedule: (work: () => Promise<void>) => void;
  task: (userId: string, taskId: string) => Promise<unknown>;
  discovery: (userId: string) => Promise<unknown>;
};

/** Background work belongs to the authenticated request and its already approved durable task. */
export function createServerlessRoute(dependencies: Dependencies) {
  return async (request: Request, path: string[]) => {
    if (process.env.DATABASE_PROVIDER !== 'postgres' || !process.env.SUPABASE_DATABASE_URL
      || !process.env.AI_GLOBAL_BUDGET_ID || process.env.AGENT_TASK_QUEUE_ENABLED !== 'true'
      || process.env.WORLD_CAPABILITY_ENABLED === 'true') {
      return Response.json({ error: { code: 'HOST_CONFIGURATION_REQUIRED', message: 'The hosted application is not ready. Private persistence and bounded agent processing must be configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const response = await dependencies.route(request, path);
    if (!response.ok) return response;
    const key = path.join('/');
    const taskResponse = response.status === 202 || request.method === 'GET' && /^agent-tasks\/[0-9a-f-]{36}$/i.test(key);
    const discoveryResponse = key === 'discovery/jobs' || request.method === 'POST' && ['discovery/settings', 'intent/confirm', 'intent/close/confirm'].includes(key);
    if (!taskResponse && !discoveryResponse) return response;
    try {
      const actor = await dependencies.user(request);
      if (taskResponse) {
        const value = await response.clone().json() as { data?: { taskId?: string; status?: string } };
        const taskId = value.data?.taskId;
        if (value.data?.status !== 'queued' || !taskId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return response;
        dependencies.schedule(async () => {
          try { await dependencies.task(actor.id, taskId); }
          catch { console.warn('agent_step_unavailable_review_saved_task'); }
        });
      } else {
        dependencies.schedule(async () => {
          try {
            if ((await dependencies.user(request)).id !== actor.id) return;
            await dependencies.discovery(actor.id);
          } catch { console.warn('discovery_check_unavailable'); }
        });
      }
    } catch { /* A successful response never becomes a repeated action after a session change. */ }
    return response;
  };
}

export const route = createServerlessRoute({
  route: applicationRoute, user: requireUser, schedule: work => after(work),
  task: (userId, taskId) => drainAgentTasks({ userId, taskId, singleTurn: true,
    deadlineMs: Math.min(Date.now() + 280000, (getDeadline()?.getTime() ?? Date.now() + 290000) - 10000) }),
  discovery: userId => discoveryTick(undefined, { userId, maximumJobs: 1 }),
});
