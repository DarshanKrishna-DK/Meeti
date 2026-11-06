'use client';

async function request(path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch('/api/' + path, { cache: 'no-store', method: body === undefined ? 'GET' : 'POST',
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
