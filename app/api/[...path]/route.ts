import { route } from 'meeti-api-handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return route(request, (await context.params).path); }
export async function POST(request: Request, context: Context) { return route(request, (await context.params).path); }
