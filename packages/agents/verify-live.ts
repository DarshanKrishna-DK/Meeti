/**
 * Explicit real-provider diagnostic. Never imported by the application.
 * All participants and authority receipts below are synthetic fixtures.
 * Default run uses at most three calls. Any cumulative continuation requires separate authorization.
 * node --env-file=.env.local node_modules/tsx/dist/cli.mjs packages/agents/verify-live.ts
 */
import assert from "node:assert/strict";
import {
  AgentError, createProviderFromEnv, MeetiAgentService,
  type AgentParticipant, type InferenceReceipt, type PolicyAuthorizer, type StructuredProvider,
} from "./src/index";

const forbiddenFixture = "SYNTHETIC_PRIVATE_CONTACT_MUST_NEVER_REACH_PROVIDER_9e81";
const purpose = "synthetic-accessibility-collaboration";
const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
const participants: AgentParticipant[] = [
  {
    userId: "synthetic-owner-builder", agentId: "synthetic-agent-builder",
    intent: {
      id: "synthetic-intent-builder", version: 1, goal: "collaborator",
      summary: "I can build a TypeScript prototype for an accessible community app. I seek a collaborator who can review keyboard navigation and plan usability research.",
      tags: ["accessibility", "typescript"], expiresAt,
    },
    fields: [
      { id: "skills", label: "Public skills", value: "TypeScript, React, keyboard navigation implementation", visibility: "public" },
      { id: "preferences", label: "Public collaboration preferences", value: "A small prototype, asynchronous feedback, and two hours per week", visibility: "public" },
      { id: "contact", label: "Private contact fixture", value: forbiddenFixture, visibility: "private", providerAllowed: false },
    ],
  },
  {
    userId: "synthetic-owner-designer", agentId: "synthetic-agent-designer",
    intent: {
      id: "synthetic-intent-designer", version: 1, goal: "collaborator",
      summary: "I can review accessibility and design a usability study for a community app. I seek a TypeScript collaborator to implement a prototype before recruiting study participants.",
      tags: ["accessibility", "typescript"], expiresAt,
    },
    fields: [
      { id: "skills", label: "Public skills", value: "Accessibility review, interaction design, usability research planning", visibility: "public" },
      { id: "preferences", label: "Public collaboration preferences", value: "Research planning first, weekend reviews, and no scheduled live meetings", visibility: "public" },
      { id: "contact", label: "Private contact fixture", value: forbiddenFixture, visibility: "private", providerAllowed: false },
    ],
  },
];

// Diagnostic fixture only. This never resolves ENS and cannot authorize application actions.
const syntheticAuthorizer: PolicyAuthorizer = async (request) => ({
  allowed: request.purpose === purpose
    && ["evaluate", "negotiate"].includes(request.action)
    && participants.some((participant) => participant.userId === request.actorId)
    && participants.some((participant) => participant.userId === request.subjectId)
    && request.actorId !== request.subjectId,
  reason: "Synthetic diagnostic policy receipt. No real ENS authority has been verified.",
  policyVersion: 1,
  allowedFieldIds: request.fieldIds.filter((fieldId) => ["skills", "preferences"].includes(fieldId)),
  checkedAt: new Date().toISOString(), expiresAt,
});

async function main() {
  const evaluationOnly = process.argv.includes("--evaluation-only");
  const previousCalls = Number(process.argv.find((argument) => argument.startsWith("--previous-calls="))?.split("=")[1] ?? 0);
  const totalCallCap = Number(process.argv.find((argument) => argument.startsWith("--total-call-cap="))?.split("=")[1] ?? 3);
  assert.ok(Number.isInteger(previousCalls) && previousCalls >= 0 && previousCalls < totalCallCap);
  assert.ok(Number.isInteger(totalCallCap) && totalCallCap >= 1 && totalCallCap <= 6);
  let transmittedRequests = 0;
  let privateFixtureAbsentChecks = 0;
  const inferenceReceipts: InferenceReceipt[] = [];
  let inspectFailedSchema: ((value: unknown) => { valid: boolean; issues: { path: string; code: string }[] }) | undefined;
  const transport: typeof fetch = async (input, init) => {
    assert.ok(previousCalls + transmittedRequests < totalCallCap, "The diagnostic cumulative outbound call cap was reached.");
    assert.equal(typeof init?.body, "string", "The provider request body must be inspectable JSON.");
    assert.ok(!String(init?.body).includes(forbiddenFixture), "A private fixture was found before transmission. No request was sent.");
    assert.ok(!String(init?.body).includes("synthetic-owner-"), "Owner identifiers cannot enter the provider projection.");
    privateFixtureAbsentChecks += 1;
    transmittedRequests += 1;
    const response = await fetch(input, init);
    if (response.ok) {
      // Completion metadata is observable even when strict local parsing subsequently rejects content.
      try {
        const completion = await response.clone().json() as { id?: unknown; choices?: { finish_reason?: unknown; message?: { content?: unknown } }[]; usage?: { completion_tokens?: unknown } };
        const content = completion.choices?.[0]?.message?.content;
        let validJson = false;
        let parsePosition: number | null = null;
        let schema: ReturnType<NonNullable<typeof inspectFailedSchema>> | null = null;
        if (typeof content === "string") {
          try {
            const value: unknown = JSON.parse(content);
            validJson = true;
            schema = inspectFailedSchema?.(value) ?? null;
          } catch (error) {
            const match = error instanceof Error ? /position (\d+)/.exec(error.message) : null;
            parsePosition = match ? Number(match[1]) : null;
          }
        }
        const safeToken = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
        console.log(JSON.stringify({
          stage: "actual-completion-structure", providerRequestId: safeToken(completion.id),
          finishReason: safeToken(completion.choices?.[0]?.finish_reason),
          outputCharacters: typeof content === "string" ? content.length : null,
          validJson, parsePosition, schema,
          startsWithObject: typeof content === "string" ? content.trimStart().startsWith("{") : null,
          endsWithObject: typeof content === "string" ? content.trimEnd().endsWith("}") : null,
          hasMarkdownFence: typeof content === "string" ? content.includes("```") : null,
          completionTokens: typeof completion.usage?.completion_tokens === "number" ? completion.usage.completion_tokens : null,
        }));
      } catch { console.error(JSON.stringify({ stage: "actual-completion-structure", parseableEnvelope: false })); }
    }
    if (!response.ok) {
      // Diagnostic-only metadata. Never print upstream messages, failed_generation, or response bodies.
      try {
        const body: unknown = await response.clone().json();
        const upstreamError = body && typeof body === "object" && "error" in body ? body.error : undefined;
        if (upstreamError && typeof upstreamError === "object") {
          const safeToken = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
          const message = "message" in upstreamError && typeof upstreamError.message === "string" ? upstreamError.message : "";
          const failedGeneration = "failed_generation" in upstreamError && typeof upstreamError.failed_generation === "string" ? upstreamError.failed_generation : null;
          let failedGenerationIsJson = false;
          let failedGenerationParsePosition: number | null = null;
          let failedGenerationShape: { keys: string[]; schema?: ReturnType<NonNullable<typeof inspectFailedSchema>> } | null = null;
          if (failedGeneration) {
            try {
              const value: unknown = JSON.parse(failedGeneration);
              failedGenerationIsJson = true;
              failedGenerationShape = {
                keys: value && typeof value === "object" ? Object.keys(value).filter((key) => /^[a-z_]{1,60}$/.test(key)).slice(0, 20) : [],
                schema: inspectFailedSchema?.(value),
              };
            } catch (error) {
              // JSON parser messages can contain source text. Extract only a numeric offset.
              const match = error instanceof Error ? /position (\d+)/.exec(error.message) : null;
              failedGenerationParsePosition = match ? Number(match[1]) : null;
            }
          }
          console.error(JSON.stringify({
            stage: "upstream-error-metadata", status: response.status,
            code: safeToken("code" in upstreamError ? upstreamError.code : null),
            type: safeToken("type" in upstreamError ? upstreamError.type : null),
            mentionsOutputLimit: /max_tokens|max_completion_tokens|token limit|output limit|truncat/i.test(message),
            failedGenerationCharacters: failedGeneration?.length ?? null,
            failedGenerationIsJson,
            failedGenerationParsePosition,
            failedGenerationStartsWithObject: failedGeneration?.trimStart().startsWith("{") ?? null,
            failedGenerationEndsWithObject: failedGeneration?.trimEnd().endsWith("}") ?? null,
            failedGenerationHasMarkdownFence: failedGeneration?.includes("```") ?? null,
            failedGenerationHasAnalysisMarkers: failedGeneration ? /<think>|<analysis>|\[channel\]|<\|channel\|>|<\|analysis\|>/.test(failedGeneration) : null,
            failedGenerationShape,
            providerRequestId: safeToken(response.headers.get("x-request-id")),
          }));
        }
      } catch { console.error(JSON.stringify({ stage: "upstream-error-metadata", status: response.status, parseableError: false })); }
    }
    return response;
  };
  const realProvider = createProviderFromEnv({
    ...process.env, AI_MAX_REQUESTS: String(totalCallCap - previousCalls), AI_RESPONSE_FORMAT: process.env.AI_RESPONSE_FORMAT ?? "text",
    AI_MAX_OUTPUT_TOKENS: "4096", AI_REASONING_EFFORT: "low",
  }, transport);
  const observedProvider: StructuredProvider = {
    async generate(request) {
      inspectFailedSchema = (value) => {
        const parsed = request.outputSchema.safeParse(value);
        return { valid: parsed.success, issues: parsed.success ? [] : parsed.error.issues.slice(0, 12).map((issue) => ({
          path: issue.path.map((part) => String(part).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60)).join("."), code: issue.code,
        })) };
      };
      const result = await realProvider.generate(request);
      assert.ok(!JSON.stringify(result.output).includes(forbiddenFixture), "A private fixture appeared in provider output.");
      inferenceReceipts.push(result.inference);
      console.log(JSON.stringify({ stage: "actual-provider-receipt", task: request.task, inference: result.inference }));
      return result;
    },
  };
  const service = new MeetiAgentService(observedProvider, syntheticAuthorizer);
  const [left, right] = participants;
  const disclosure = await service.checkDisclosure(right, left, purpose, "contact");
  assert.equal(disclosure.allowed, false, "The private contact fixture must be denied.");
  console.log(JSON.stringify({ stage: "synthetic-policy-check", realEnsAuthority: false, fieldId: disclosure.fieldId, allowed: disclosure.allowed, reason: disclosure.reason }));

  try {
    const evaluation = await service.evaluateCompatibility({ left, right, purpose });
    console.log(JSON.stringify({ stage: "validated-compatibility", assessment: evaluation.output.assessment, summary: evaluation.output.summary, reasons: evaluation.output.reasons.length, exactEvidenceValidated: true }));
    if (evaluationOnly) {
      assert.equal(transmittedRequests, 1);
      console.log(JSON.stringify({ stage: "evaluation-diagnostic-passed", transmittedRequests, realEnsAuthority: false, protectedRoomReleased: false }));
      return;
    }
    const negotiation = await service.negotiateIntroduction({ left, right, purpose, maxRounds: 1 });
    assert.equal(negotiation.exchanges.length, 2);
    assert.deepEqual(negotiation.exchanges.map((exchange) => exchange.agentId), [left.agentId, right.agentId]);
    assert.equal(transmittedRequests, 3);
    assert.equal(privateFixtureAbsentChecks, 3);
    console.log(JSON.stringify({
      stage: "live-diagnostic-passed", realProvider: true, syntheticProfiles: true, realEnsAuthority: false,
      assessment: evaluation.output.assessment, transmittedRequests, privateFixtureAbsentChecks,
      cumulativeTransmittedRequests: previousCalls + transmittedRequests,
      deniedField: disclosure.fieldId, exchanges: negotiation.exchanges.map(({ agentId, message, questions, inference }) => ({ agentId, message, questions, providerRequestId: inference.providerRequestId })),
      protectedRoomReleased: false,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      stage: "live-diagnostic-stopped", code: error instanceof AgentError ? error.code : "diagnostic_assertion",
      message: error instanceof AgentError ? error.message : "A local diagnostic assertion failed.",
      transmittedRequests, cumulativeTransmittedRequests: previousCalls + transmittedRequests, privateFixtureAbsentChecks, completedProviderReceipts: inferenceReceipts.map((receipt) => receipt.providerRequestId),
      retried: false, realEnsAuthority: false,
    }));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ stage: "diagnostic-configuration-failed", code: error instanceof AgentError ? error.code : "diagnostic_assertion", message: error instanceof AgentError ? error.message : "The diagnostic could not start.", retried: false }));
  process.exitCode = 1;
});
