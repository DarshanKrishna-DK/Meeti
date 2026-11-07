'use client';

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch('/api/' + path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal, method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Meeti could not reach the server. Check Agent activity before repeating a submitted action. If a wallet transaction was submitted, reconcile it in Settings.');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('The server returned an unreadable response. Check current activity before retrying.'); }
  if (!response.ok || payload.error) throw new Error(payload.error?.message || 'This request could not be completed.');
  return { status: response.status, data: payload.data };
}
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'expired';
type EnqueuedTask = { kind: 'queued'; taskId: string; status: 'queued' | 'running'; deduplicated: boolean };
/** Submit once and return the durable receipt so the activity page can follow real progress. */
export async function apiEnqueue<T = unknown>(path: string, body: unknown): Promise<EnqueuedTask | { kind: 'completed'; data: T }> {
  const result = await request(path, body);
  if (result.status !== 202) return { kind: 'completed', data: result.data as T };
  const task = result.data;
  if (!task || typeof task.taskId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(task.taskId)
    || !['queued', 'running'].includes(task.status) || typeof task.deduplicated !== 'boolean') {
    throw new Error('The queued action did not return a valid task receipt. Check Agent activity before submitting another request.');
  }
  return { kind: 'queued', taskId: task.taskId, status: task.status, deduplicated: task.deduplicated };
}
type PollVisibility = { hidden: boolean; addEventListener(type: 'visibilitychange', listener: () => void): void; removeEventListener(type: 'visibilitychange', listener: () => void): void };
/** Follow only existing authenticated task IDs. This watcher never submits or retries an action. */
export function watchAgentTasks(options: {
  taskIds: readonly string[]; refresh: () => Promise<void>; paused?: () => boolean; onError?: (error: Error) => void; visibility?: PollVisibility;
}) {
  const pending = new Set(options.taskIds);
  if (pending.size > 1 || [...pending].some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) throw new Error('The saved task identifier could not be verified. Refresh Agent activity.');
  const visibility = options.visibility || (typeof document !== 'undefined' ? document : undefined);
  let stopped = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  const hidden = () => Boolean(visibility?.hidden);
  function schedule() { if (!stopped && pending.size && !hidden()) timer = setTimeout(() => { void tick(); }, 5000); }
  async function tick() {
    clearTimeout(timer);
    if (stopped || inFlight || !pending.size || hidden()) return;
    if (options.paused?.()) { schedule(); return; }
    inFlight = true; controller = new AbortController();
    try {
      for (const id of pending) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        const task = (await request(`agent-tasks/${id}`, undefined, signal)).data as { taskId: string; status: TaskStatus };
        if (stopped || controller.signal.aborted) return;
        if (task.taskId !== id || !['queued', 'running', 'completed', 'failed', 'interrupted', 'expired'].includes(task.status)) throw new Error('The saved task state could not be verified. Refresh Agent activity.');
        if (!['queued', 'running'].includes(task.status)) pending.delete(id);
      }
      if (!stopped && !hidden()) await options.refresh();
    } catch (failure) {
      if (!stopped && !controller.signal.aborted) options.onError?.(failure instanceof Error ? failure : new Error('Task progress could not refresh. Retry when the connection returns.'));
    } finally { inFlight = false; controller = undefined; schedule(); }
  }
  function visibilityChanged() {
    clearTimeout(timer);
    if (hidden()) controller?.abort();
    else if (!inFlight) void tick();
  }
  visibility?.addEventListener('visibilitychange', visibilityChanged);
  void tick();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); visibility?.removeEventListener('visibilitychange', visibilityChanged); };
}
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const result = await request(path, body);
  if (result.status !== 202) return result.data as T;
  const id = result.data?.taskId;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('The queued action did not return a valid identifier. Check Agent activity.');
  // Poll only the recorded task. A slow connection never resubmits the model action.
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const task = (await request(`agent-tasks/${id}`)).data;
    if (task.status === 'completed') return task.result as T;
    if (['failed', 'interrupted', 'expired'].includes(task.status)) throw new Error(task.error?.message || 'The task stopped. Review Agent activity before requesting another attempt.');
    if (!['queued', 'running'].includes(task.status)) throw new Error('The task state could not be verified. Review Agent activity.');
  }
  throw new Error('Your agent task is still pending. You can refresh and follow it in Agent activity. Do not submit it again while it is running.');
}
