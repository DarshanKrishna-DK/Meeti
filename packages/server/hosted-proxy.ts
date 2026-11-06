// The frontend deployment contains this proxy instead of database and model runtimes.
export async function route(request: Request, path: string[]): Promise<Response> {
  const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
  let target: URL;
  try { target = new URL(process.env.BACKEND_API_ORIGIN || ''); }
  catch { return fail(503, 'BACKEND_UNCONFIGURED', 'The application backend is not configured.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return fail(503, 'BACKEND_UNCONFIGURED', 'The application backend is not configured.');
  if (!path.length || path.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return fail(404, 'NOT_FOUND', 'This endpoint was not found.');
  if (!['GET', 'POST'].includes(request.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
  const headers = new Headers();
  for (const key of ['content-type', 'cookie', 'origin', 'accept']) {
    const value = request.headers.get(key); if (value !== null) headers.set(key, value);
  }
  let body: Uint8Array | undefined;
  if (request.method === 'POST') {
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 1410000) { await reader.cancel(); return fail(413, 'BODY_TOO_LARGE', 'The request exceeds the upload limit.'); }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks);
  }
  target.pathname = '/api/' + path.join('/');
  try {
    const upstream = await fetch(target, { method: request.method, headers, body: body as BodyInit | undefined,
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(55000) });
    if (upstream.status >= 300 && upstream.status < 400) return fail(502, 'BACKEND_REDIRECT_DENIED', 'The backend returned an unexpected redirect.');
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const key of ['content-type', 'content-disposition', 'retry-after']) {
      const value = upstream.headers.get(key); if (value) responseHeaders.set(key, value);
    }
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return fail(503, 'BACKEND_UNAVAILABLE', 'The backend is waking up or could not be reached. Retry shortly. Check existing activity before repeating a submitted action.');
  }
}
