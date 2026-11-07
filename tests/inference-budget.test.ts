import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { AgentError, OpenAICompatibleProvider, type StructuredProvider } from '../packages/agents/src/provider';
import { db, closeDatabase } from '../packages/server/db';
import { closeStore } from '../packages/server/store';
import { durableInferenceProvider, inferenceBudgetConfiguration } from '../packages/server/inference-budget';

let directory: string;
const environment = { AI_ENFORCE_BUDGETS: 'true', DATABASE_PROVIDER: 'sqlite', AI_GLOBAL_BUDGET_ID: 'fixture-deployment-budget', AI_MODEL: 'fixture-model', AI_BASE_URL: 'https://provider.fixture.invalid/v1',
  AI_INPUT_USD_PER_MILLION: '1', AI_OUTPUT_USD_PER_MILLION: '1', AI_MAX_OUTPUT_TOKENS: '128', AI_MAX_INPUT_BYTES: '24000' };
const input = () => ({ task: 'fixture_task', instructions: 'Return the fixture result.', data: { public: 'fictional' }, outputSchema: z.object({ ok: z.boolean() }) });
function seed(maxRequests = 3, maxCost = 100_000_000) {
  const config = inferenceBudgetConfiguration(environment), now = new Date().toISOString();
  db().prepare('INSERT INTO inference_budgets VALUES(?,?,?,?,?,?,?,?,?,?)').run(config.id, config.model, config.configDigest, maxRequests, maxCost, 0, 0, 'active', now, now);
}
function budget() { return db().prepare('SELECT * FROM inference_budgets').get()!; }
function provider(transport: Mock<typeof fetch> = vi.fn(async () => new Response(JSON.stringify({ id: 'fixture-completion', model: environment.AI_MODEL,
  choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })))) {
  const delegate = new OpenAICompatibleProvider({ baseUrl: environment.AI_BASE_URL, apiKey: 'test-only-key', model: environment.AI_MODEL,
    timeoutMs: 100, maxRequests: 10, maxCostUsd: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxOutputTokens: 128, maxInputBytes: 24000 }, transport);
  return { wrapped: durableInferenceProvider(delegate, environment), transport, delegate };
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-inference-budget-'));
  vi.stubEnv('DATABASE_PROVIDER', 'sqlite'); vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite'));
  db().exec(readFileSync('migrations/009_inference_budget.sql', 'utf8'));
});
afterEach(async () => { await closeStore(); closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('durable global model allowance with real adapter and fixture HTTP', () => {
  it('preserves the local process-only mode without an explicit global allowance', () => {
    const { delegate } = provider(); expect(durableInferenceProvider(delegate, {})).toBe(delegate);
    expect(() => durableInferenceProvider(delegate, { DATABASE_PROVIDER: 'postgres', AI_ENFORCE_BUDGETS: 'true' })).toThrow(AgentError);
  });
  it('bypasses the ledger when application budgets are disabled', async () => {
    seed(0); const { delegate } = provider();
    const wrapped = durableInferenceProvider(delegate, { ...environment, AI_ENFORCE_BUDGETS: 'false' });
    expect(wrapped).toBe(delegate); expect((await wrapped.generate(input())).output).toEqual({ ok: true });
    expect(budget().used_requests).toBe(0);
  });
  it('binds model, endpoint, prices and input/output limits but permits credential rotation', () => {
    const first = inferenceBudgetConfiguration(environment);
    expect(inferenceBudgetConfiguration({ ...environment, AI_API_KEY: 'rotated-fixture' })).toEqual(first);
    for (const override of [{ AI_MODEL: 'other' }, { AI_BASE_URL: 'https://other.fixture.invalid/v1' }, { AI_INPUT_USD_PER_MILLION: '0' }, { AI_OUTPUT_USD_PER_MILLION: '0' }, { AI_MAX_OUTPUT_TOKENS: '256' }, { AI_MAX_INPUT_BYTES: '32000' }]) {
      expect(inferenceBudgetConfiguration({ ...environment, ...override }).configDigest).not.toBe(first.configDigest);
    }
  });
  it('does not auto-provision a missing allowance or dispatch a model call', async () => {
    const { wrapped, transport } = provider(); await expect(wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(transport).not.toHaveBeenCalled(); expect(db().prepare('SELECT * FROM inference_budgets').all()).toEqual([]);
  });
  it('persists a conservative reservation before dispatch, settles only known usage and never refunds request count', async () => {
    seed(); const transport = vi.fn(async () => {
      expect(budget().used_requests).toBe(1); expect(Number(budget().charged_nusd)).toBeGreaterThan(12000);
      expect(db().prepare('SELECT state FROM inference_attempts').get()?.state).toBe('reserved');
      return new Response(JSON.stringify({ model: environment.AI_MODEL, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
    const { wrapped } = provider(transport); expect((await wrapped.generate(input())).output).toEqual({ ok: true });
    expect(budget()).toMatchObject({ used_requests: 1, charged_nusd: 12000 });
    expect(db().prepare('SELECT * FROM inference_attempts').get()).toMatchObject({ state: 'settled', charged_nusd: 12000, task: 'fixture_task' });
    expect(JSON.stringify(db().prepare('SELECT * FROM inference_attempts').all())).not.toContain('fictional');
  });
  it('does not reset the global request cap when the provider process is recreated', async () => {
    seed(1); const first = provider(); await first.wrapped.generate(input());
    const restarted = provider(); await expect(restarted.wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(restarted.transport).not.toHaveBeenCalled(); expect(budget().used_requests).toBe(1);
  });
  it('serializes independent provider instances against the same final allowance', async () => {
    seed(1); const left = provider(), right = provider();
    const results = await Promise.allSettled([left.wrapped.generate(input()), right.wrapped.generate(input())]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(left.transport.mock.calls.length + right.transport.mock.calls.length).toBe(1);
    expect(budget().used_requests).toBe(1);
  });
  it.each(['provider_error', 'invalid_output'])('keeps the full reservation on an unknown or rejected outcome: %s', async failure => {
    seed(); const transport = vi.fn(async () => failure === 'provider_error' ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({
      model: environment.AI_MODEL, choices: [{ finish_reason: 'stop', message: { content: '{"wrong":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 },
    })));
    await expect(provider(transport).wrapped.generate(input())).rejects.toBeInstanceOf(AgentError);
    const attempt = db().prepare('SELECT * FROM inference_attempts').get()!;
    expect(attempt.state).toBe('reserved'); expect(attempt.charged_nusd).toBe(attempt.reserved_nusd);
    expect(budget()).toMatchObject({ used_requests: 1, charged_nusd: attempt.reserved_nusd });
  });
  it('honors caller authorization failure before consuming global quota', async () => {
    seed(); const { wrapped, transport } = provider(); const beforeInference = vi.fn(async () => { throw new AgentError('policy', 'Denied fixture.'); });
    await expect(wrapped.generate({ ...input(), beforeInference })).rejects.toMatchObject({ code: 'policy' });
    expect(transport).not.toHaveBeenCalled(); expect(budget().used_requests).toBe(0);
  });
  it.each(['state', 'model', 'config_digest', 'max_cost_nusd'])('denies blocked, changed or insufficient configuration: %s', async column => {
    seed(); const value = column === 'state' ? 'blocked' : column === 'max_cost_nusd' ? 1 : 'changed';
    db().prepare(`UPDATE inference_budgets SET ${column}=?`).run(value);
    const { wrapped, transport } = provider(); await expect(wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' }); expect(transport).not.toHaveBeenCalled();
  });
  it('fails closed on missing database tables without exposing SQL details', async () => {
    db().exec('DROP TABLE inference_attempts; DROP TABLE inference_budgets;');
    const { wrapped, transport } = provider(); await expect(wrapped.generate(input())).rejects.toThrow('AI processing is blocked because the durable budget is unavailable, changed or exhausted.'); expect(transport).not.toHaveBeenCalled();
  });
  it('retains the reservation if configuration changes after a real adapter dispatch', async () => {
    seed(); const transport = vi.fn(async () => {
      db().prepare("UPDATE inference_budgets SET config_digest='changed'").run();
      return new Response(JSON.stringify({ model: environment.AI_MODEL, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
    await expect(provider(transport).wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(transport).toHaveBeenCalledOnce(); const attempt = db().prepare('SELECT * FROM inference_attempts').get()!;
    expect(attempt.state).toBe('reserved'); expect(budget().charged_nusd).toBe(attempt.reserved_nusd);
  });
  it('preserves unknown timeout cost rather than refunding an aborted request', async () => {
    seed(); const transport = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('fixture network timeout')), { once: true });
    }));
    await expect(provider(transport).wrapped.generate(input())).rejects.toMatchObject({ code: 'timeout' });
    const attempt = db().prepare('SELECT * FROM inference_attempts').get()!;
    expect(attempt.state).toBe('reserved'); expect(budget().charged_nusd).toBe(attempt.reserved_nusd);
  });
  it('records a known overrun, blocks the allowance and does not return a successful result', async () => {
    seed(); const delegate: StructuredProvider = { async generate(request) {
      const requestId = randomUUID(); await request.beforeInference?.({ requestId, model: environment.AI_MODEL, reservedCostUsd: 0.000001 });
      return { output: request.outputSchema.parse({ ok: true }), inference: { requestId, providerRequestId: null, model: environment.AI_MODEL,
        inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.000002, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } };
    } };
    await expect(durableInferenceProvider(delegate, environment).generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(budget()).toMatchObject({ state: 'blocked', charged_nusd: 2000, used_requests: 1 });
    expect(db().prepare('SELECT * FROM inference_attempts').get()).toMatchObject({ state: 'overrun', reserved_nusd: 1000, charged_nusd: 2000 });
    const next = provider(); await expect(next.wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' }); expect(next.transport).not.toHaveBeenCalled();
  });
  it('blocks restarts after the delegate detects a usage overrun without a successful receipt', async () => {
    seed(); const delegate: StructuredProvider = { async generate(request) {
      await request.beforeInference?.({ requestId: randomUUID(), model: environment.AI_MODEL, reservedCostUsd: 0.001 });
      throw new AgentError('budget', 'The fixture provider detected unexpected usage.');
    } };
    await expect(durableInferenceProvider(delegate, environment).generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(budget()).toMatchObject({ state: 'blocked', charged_nusd: 1_000_000, used_requests: 1 });
    expect(db().prepare('SELECT state FROM inference_attempts').get()?.state).toBe('reserved');
    const restarted = provider(); await expect(restarted.wrapped.generate(input())).rejects.toMatchObject({ code: 'budget' }); expect(restarted.transport).not.toHaveBeenCalled();
  });
  it('rejects a replayed request identifier instead of authorizing another dispatch', async () => {
    seed(); const requestId = randomUUID(), dispatch = vi.fn();
    const delegate: StructuredProvider = { async generate(request) {
      await request.beforeInference?.({ requestId, model: environment.AI_MODEL, reservedCostUsd: 0.001 }); dispatch();
      throw new AgentError('provider', 'Unknown fixture outcome.');
    } };
    await expect(durableInferenceProvider(delegate, environment).generate(input())).rejects.toMatchObject({ code: 'provider' });
    await expect(durableInferenceProvider(delegate, environment).generate(input())).rejects.toMatchObject({ code: 'budget' });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(budget().used_requests).toBe(1);
  });
});
