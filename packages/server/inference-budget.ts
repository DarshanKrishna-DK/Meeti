import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentError, type InferenceReceipt, type InferenceReservation, type StructuredProvider } from '../agents/src/provider';
import { atomic, db } from './store';

type Environment = Record<string, string | undefined>;
type Binding = { id: string; model: string; configDigest: string };
type Request<T> = { task: string; instructions: string; data: unknown; outputSchema: z.ZodType<T>; beforeInference?: (reservation: InferenceReservation) => void | Promise<void> };
const unavailable = () => new AgentError('budget', 'AI processing is blocked because the durable budget is unavailable, changed or exhausted.');

function integer(value: unknown) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw unavailable();
  const result = typeof value === 'string' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw unavailable();
  return result;
}
function nanos(value: number) {
  if (!Number.isFinite(value) || value < 0) throw unavailable();
  return integer(Math.ceil(value * 1_000_000_000));
}

/** Keys are intentionally excluded so a credential rotation cannot reset or fork the deployment allowance. */
export function inferenceBudgetConfiguration(environment: Environment = process.env): Binding {
  const id = environment.AI_GLOBAL_BUDGET_ID || '', model = environment.AI_MODEL || '';
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(id) || !model || model.length > 200) throw new AgentError('configuration', 'Configure an explicit durable AI budget identifier and model.');
  let endpoint: URL;
  try { endpoint = new URL(environment.AI_BASE_URL || 'https://api.openai.com/v1'); } catch { throw unavailable(); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)) throw unavailable();
  const numeric = (name: string, fallback: number) => {
    const value = environment[name] === undefined || environment[name]?.trim() === '' ? fallback : Number(environment[name]);
    if (!Number.isFinite(value) || value < 0) throw unavailable();
    return value;
  };
  const configDigest = createHash('sha256').update(JSON.stringify({ version: 1, endpoint: endpoint.toString().replace(/\/$/, ''), model,
    inputUsdPerMillion: numeric('AI_INPUT_USD_PER_MILLION', NaN), outputUsdPerMillion: numeric('AI_OUTPUT_USD_PER_MILLION', NaN),
    maxInputBytes: numeric('AI_MAX_INPUT_BYTES', 24000), maxOutputTokens: numeric('AI_MAX_OUTPUT_TOKENS', 1200),
  })).digest('hex');
  return { id, model, configDigest };
}

/** No runtime provisioning or allowance reset. Unknown outcomes retain the complete conservative reservation. */
export function durableInferenceProvider(delegate: StructuredProvider, environment: Environment = process.env): StructuredProvider {
  if (environment.DATABASE_PROVIDER !== 'postgres' && !environment.AI_GLOBAL_BUDGET_ID) return delegate;
  const binding = inferenceBudgetConfiguration(environment);
  async function reserve(task: string, reservation: InferenceReservation) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(task) || !z.string().uuid().safeParse(reservation.requestId).success || reservation.model !== binding.model) throw unavailable();
    const charge = nanos(reservation.reservedCostUsd);
    try {
      await atomic(async () => {
        const budget = await db().prepare('SELECT * FROM inference_budgets WHERE id=?').get(binding.id);
        if (!budget || budget.state !== 'active' || budget.model !== binding.model || budget.config_digest !== binding.configDigest) throw unavailable();
        const used = integer(budget.used_requests), spent = integer(budget.charged_nusd), maxRequests = integer(budget.max_requests), maxCost = integer(budget.max_cost_nusd);
        if (used >= maxRequests || spent > maxCost || charge > maxCost - spent) throw unavailable();
        if (await db().prepare('SELECT request_id FROM inference_attempts WHERE request_id=?').get(reservation.requestId)) throw unavailable();
        const now = new Date().toISOString();
        const updated = await db().prepare("UPDATE inference_budgets SET used_requests=?,charged_nusd=?,updated_at=? WHERE id=? AND used_requests=? AND charged_nusd=? AND state='active'").run(used + 1, spent + charge, now, binding.id, used, spent);
        if (updated.changes !== 1) throw unavailable();
        await db().prepare("INSERT INTO inference_attempts(request_id,budget_id,task,model,reserved_nusd,charged_nusd,state,created_at,settled_at) VALUES(?,?,?,?,?,?,'reserved',?,NULL)").run(reservation.requestId, binding.id, task, binding.model, charge, charge, now);
      });
    } catch { throw unavailable(); }
  }
  async function settle(reservation: InferenceReservation, receipt: InferenceReceipt) {
    if (receipt.requestId !== reservation.requestId || receipt.model !== binding.model
      || !Number.isSafeInteger(receipt.inputTokens) || receipt.inputTokens < 0 || !Number.isSafeInteger(receipt.outputTokens) || receipt.outputTokens < 0) throw unavailable();
    const actual = nanos(receipt.estimatedCostUsd);
    try {
      return await atomic(async () => {
        const attempt = await db().prepare('SELECT * FROM inference_attempts WHERE request_id=? AND budget_id=?').get(reservation.requestId, binding.id);
        const budget = await db().prepare('SELECT * FROM inference_budgets WHERE id=?').get(binding.id);
        if (!attempt || !budget || attempt.state !== 'reserved' || attempt.model !== binding.model || budget.model !== binding.model || budget.config_digest !== binding.configDigest) throw unavailable();
        const reserved = integer(attempt.reserved_nusd), prior = integer(attempt.charged_nusd), spent = integer(budget.charged_nusd);
        if (prior !== reserved || spent < prior) throw unavailable();
        const charged = integer(spent - prior + actual), overrun = actual > reserved || charged > integer(budget.max_cost_nusd);
        const now = new Date().toISOString();
        const updated = await db().prepare("UPDATE inference_attempts SET charged_nusd=?,state=?,settled_at=? WHERE request_id=? AND state='reserved'").run(actual, overrun ? 'overrun' : 'settled', now, reservation.requestId);
        if (updated.changes !== 1) throw unavailable();
        await db().prepare('UPDATE inference_budgets SET charged_nusd=?,state=?,updated_at=? WHERE id=?').run(charged, overrun || budget.state !== 'active' ? 'blocked' : 'active', now, binding.id);
        return !overrun;
      });
    } catch { throw unavailable(); }
  }
  return { async generate<T>(request: Request<T>) {
    let reservation: InferenceReservation | undefined;
    let result: { output: T; inference: InferenceReceipt };
    try {
      result = await delegate.generate({ ...request, beforeInference: async value => {
        if (reservation) throw unavailable();
        // The existing caller authorizer and qualification ledger must succeed before the global dispatch allowance.
        await request.beforeInference?.(value);
        await reserve(request.task, value);
        reservation = { ...value };
      } });
    } catch (error) {
      if (reservation && error instanceof AgentError && error.code === 'budget') {
        // A provider-detected usage overrun has no successful receipt. Keep its reserve and disable future dispatches.
        try { await db().prepare("UPDATE inference_budgets SET state='blocked',updated_at=? WHERE id=?").run(new Date().toISOString(), binding.id); }
        catch { throw unavailable(); }
      }
      throw error;
    }
    if (!reservation || !await settle(reservation, result.inference)) throw unavailable();
    return result;
  } };
}
