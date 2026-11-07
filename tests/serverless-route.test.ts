import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('../packages/server/router', () => ({ route: vi.fn() }));
vi.mock('../packages/server/security', () => ({ requireUser: vi.fn() }));
vi.mock('../packages/server/agent-tasks', () => ({ drainAgentTasks: vi.fn() }));
vi.mock('../packages/server/discovery-jobs', () => ({ discoveryTick: vi.fn() }));
import { createServerlessRoute } from '../packages/server/serverless-route';

const id = 'a718675d-c67d-4c8b-9a60-01369bd855c9';
function fixture(status = 'queued', httpStatus = 202) {
  const work: (() => Promise<void>)[] = [];
  const route = vi.fn(async () => Response.json({ data: { taskId: id, status } }, { status: httpStatus }));
  const user = vi.fn(async () => ({ id: 'owner' } as never));
  const task = vi.fn(async () => ({})), discovery = vi.fn(async () => ({})), autoQualification=vi.fn(async()=>({}));
  const handle = createServerlessRoute({ route, user, task, discovery, autoQualification, schedule: job => work.push(job) });
  return { handle, route, user, task, discovery, autoQualification, work };
}
beforeEach(() => {
  vi.stubEnv('DATABASE_PROVIDER', 'postgres'); vi.stubEnv('SUPABASE_DATABASE_URL', 'fixture-not-a-credential');
  vi.stubEnv('AI_GLOBAL_BUDGET_ID', 'fixture'); vi.stubEnv('AGENT_TASK_QUEUE_ENABLED', 'true'); vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
});
afterEach(() => vi.unstubAllEnvs());
describe('serverless continuation boundary', () => {
  it('schedules the exact opted-in confirmed publication batch instead of a second discovery scan',async()=>{
    const f=fixture();f.route.mockResolvedValue(Response.json({data:{entityKey:'fixture',autoQualification:{batchId:id,status:'queued'}}}));
    await f.handle(new Request('https://app.test/api/intent/confirm',{method:'POST'}),['intent','confirm']);
    expect(f.work).toHaveLength(1);await f.work[0]();expect(f.autoQualification).toHaveBeenCalledWith('owner',id);expect(f.discovery).not.toHaveBeenCalled();expect(f.task).not.toHaveBeenCalled();
  });
  it('continues only an authenticated saved active batch on owner polling',async()=>{
    const f=fixture();f.route.mockResolvedValue(Response.json({data:[{batchId:id,status:'qualifying'}]}));
    await f.handle(new Request('https://app.test/api/auto-qualifications'),['auto-qualifications']);expect(f.work).toHaveLength(1);
    f.user.mockResolvedValue({id:'another-owner'} as never);await f.work[0]();expect(f.autoQualification).not.toHaveBeenCalled();
  });
  it('fails closed without durable hosting configuration', async () => {
    vi.stubEnv('DATABASE_PROVIDER', 'sqlite'); const f = fixture();
    expect((await f.handle(new Request('https://app.test/api/health'), ['health'])).status).toBe(503);
    expect(f.route).not.toHaveBeenCalled(); expect(f.work).toHaveLength(0);
  });
  it('schedules only the authenticated owner and already accepted task', async () => {
    const f = fixture(); await f.handle(new Request('https://app.test/api/proposals', { method: 'POST' }), ['proposals']);
    expect(f.work).toHaveLength(1); expect(f.task).not.toHaveBeenCalled(); await f.work[0]();
    expect(f.task).toHaveBeenCalledWith('owner', id); expect(f.discovery).not.toHaveBeenCalled();
  });
  it.each(['running', 'failed', 'completed', 'interrupted', 'expired'])('does not restart %s work on polling', async status => {
    const f = fixture(status, 200); await f.handle(new Request(`https://app.test/api/agent-tasks/${id}`), ['agent-tasks', id]);
    expect(f.work).toHaveLength(0);
  });
  it('does not schedule a foreign task rejected by the main router', async () => {
    const f = fixture('queued', 404); await f.handle(new Request(`https://app.test/api/agent-tasks/${id}`), ['agent-tasks', id]);
    expect(f.user).not.toHaveBeenCalled(); expect(f.work).toHaveLength(0);
  });
  it('does not schedule after a changed or expired session', async () => {
    const f = fixture(); f.user.mockRejectedValue(new Error('session closed'));
    expect((await f.handle(new Request('https://app.test/api/proposals', { method: 'POST' }), ['proposals'])).status).toBe(202);
    expect(f.work).toHaveLength(0);
  });
  it('scopes enabled discovery to the still authenticated owner', async () => {
    const f = fixture('queued', 200); await f.handle(new Request('https://app.test/api/discovery/jobs'), ['discovery', 'jobs']);
    expect(f.work).toHaveLength(1); await f.work[0](); expect(f.discovery).toHaveBeenCalledWith('owner');
    expect(f.task).not.toHaveBeenCalled();
  });
});
