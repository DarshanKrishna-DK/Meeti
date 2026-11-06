import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MeetiAgentService, OpenAICompatibleProvider, QUALIFICATION_RUBRICS,
  type AgentParticipant, type PolicyAuthorizer, type QualificationOwnerAnswer, type StructuredProvider,
} from "../src";

const participant = (id: string): AgentParticipant => ({
  userId: `test-user-${id}`, agentId: `test-agent-${id}`,
  intent: { id: `test-intent-${id}`, version: 1, goal: "collaborator", summary: "Build an accessible app together", tags: ["accessibility"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  fields: [
    { id: "skills", label: "Skills", value: "TypeScript", visibility: "public" },
    { id: "contact", label: "Contact", value: "test-private-contact@example.test", visibility: "private" },
  ],
});
const authorize: PolicyAuthorizer = async request => ({ allowed: true, reason: "Test fixture only", policyVersion: 1,
  allowedFieldIds: request.fieldIds.filter(id => id !== "contact"), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
type TurnData = { self: { agentId: string }; other: { agentId: string }; round: number; priorPeerMessages: unknown[]; answerReferences: unknown[] };
function turn(data: TurnData, missing = false) {
  const own = `${data.self.agentId}:intent:summary`, peer = `${data.other.agentId}:intent:summary`;
  return {
    message: "The stated app collaboration is relevant. Let us clarify the contribution scope.",
    findings: QUALIFICATION_RUBRICS.collaborator.map(criterion => ({ criterionId: criterion.id,
      status: missing && criterion.id === "scope_expectations" ? "unknown" : "supported",
      explanation: missing && criterion.id === "scope_expectations" ? "The expected scope is unstated." : "Both supplied goals describe the accessible app.",
      evidenceReferences: missing && criterion.id === "scope_expectations" ? [] : [own, peer],
    })),
    peerQuestions: [], ownerQuestions: missing ? [{ owner: "self", criterionIds: ["scope_expectations"], question: "What contribution do you want to make to this app?" }] : [],
    requestedFieldIds: [], evidence: [{ reference: own, quote: "accessible app" }, { reference: peer, quote: "accessible app" }],
  };
}
function fixtureProvider(generate: (data: TurnData, index: number) => unknown) {
  const calls: TurnData[] = [];
  const provider: StructuredProvider = { async generate<T>(request: { data: unknown; outputSchema: z.ZodType<T> }) {
    const data = request.data as TurnData;
    calls.push(data);
    return { output: request.outputSchema.parse(generate(data, calls.length - 1)), inference: {
      requestId: crypto.randomUUID(), providerRequestId: "test-only-inference", model: "test-only-model", inputTokens: 1, outputTokens: 1,
      estimatedCostUsd: 0, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    } };
  } };
  return { provider, calls };
}
const input = () => ({ left: participant("a"), right: participant("b"), purpose: "collaborator" });

describe("bounded actual-provider qualification with test-only fixtures", () => {
  it('selects recruiting criteria from the reviewed direction instead of treating a job as generic collaboration', async () => {
    const pair = input(); pair.left.intent.direction = 'seeking-job'; pair.right.intent.direction = 'hiring';
    const { provider } = fixtureProvider(data => {
      const rubric = (data as TurnData & { rubric: { id: string }[] }).rubric;
      expect(rubric.map(item => item.id)).toContain('role_relevance');
      expect(rubric.map(item => item.id)).not.toContain('reciprocal_contribution');
      const response = turn(data);
      return { ...response, findings: rubric.map(criterion => ({ criterionId: criterion.id, status: 'supported', explanation: 'Fixture references both explicit inputs.', evidenceReferences: response.evidence.map(item => item.reference) })) };
    });
    expect((await new MeetiAgentService(provider, authorize).qualifyIntroduction(pair)).state).toBe('qualified');
  });
  it("retains the actual adapter receipt, shallow schema, two agents, and current authorization", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const data = JSON.parse(body.messages[1].content).untrustedData as TurnData;
      expect(body.response_format.json_schema.schema.properties).toHaveProperty("findings");
      expect(String(init?.body)).not.toContain("test-private-contact");
      expect(String(init?.body)).not.toContain("test-user-");
      return new Response(JSON.stringify({ id: "test-http-provider-receipt", model: "test-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(turn(data)) } }], usage: { prompt_tokens: 22, completion_tokens: 11 } }));
    });
    const policy = vi.fn(authorize);
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://test-provider.example/v1", apiKey: "test-key", model: "test-model",
      timeoutMs: 1000, maxRequests: 6, maxCostUsd: 1, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      maxOutputTokens: 1200, maxInputBytes: 24000, responseFormat: "json_schema" }, transport);
    const result = await new MeetiAgentService(provider, policy).qualifyIntroduction(input());
    expect(result).toMatchObject({ state: "qualified", stopReason: "mutual_criteria_supported", round: 1 });
    expect(result.messages.map(message => message.agentId)).toEqual(["test-agent-a", "test-agent-b"]);
    expect(result.messages.every(message => message.inference.providerRequestId === "test-http-provider-receipt")).toBe(true);
    expect(result.messages.every(message => !Number.isNaN(Date.parse(message.createdAt)))).toBe(true);
    expect(policy).toHaveBeenCalledTimes(6);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("asks the correct owners and resumes only from explicitly consented allowlisted answer fields", async () => {
    const fixture = fixtureProvider(data => turn(data, data.round === 1));
    const service = new MeetiAgentService(fixture.provider, authorize);
    const pair = input();
    const first = await service.qualifyIntroduction(pair);
    expect(first).toMatchObject({ state: "needs_owner", stopReason: "owner_information_required", round: 1 });
    expect(first.ownerQuestions).toHaveLength(2);
    const ownerAnswers: QualificationOwnerAnswer[] = first.ownerQuestions.map(question => ({ questionId: question.id,
      ownerAgentId: question.ownerAgentId, fieldId: "answer", providerDisclosureConsent: true, answeredAt: new Date().toISOString() }));
    for (const owner of [pair.left, pair.right]) owner.fields.push({ id: "answer", label: "Owner answer about scope", value: "I can build the TypeScript interface.", visibility: "private", providerAllowed: true });
    const second = await service.qualifyIntroduction({ ...pair, priorState: first, ownerAnswers });
    expect(second).toMatchObject({ id: first.id, state: "qualified", round: 2 });
    expect(second.messages).toHaveLength(4);
    expect(second.answers).toHaveLength(2);
    expect(fixture.calls[2].answerReferences).toHaveLength(2);
    // The changed disclosure projection prevents reusing older peer content.
    expect(fixture.calls[2].priorPeerMessages).toHaveLength(0);
    expect(fixture.calls[3].priorPeerMessages).toHaveLength(1);
  });

  it("rejects absent answer consent, wrong owner references, and replayed answers before inference", async () => {
    const fixture = fixtureProvider(data => turn(data, true));
    const service = new MeetiAgentService(fixture.provider, authorize), pair = input();
    const first = await service.qualifyIntroduction(pair);
    const question = first.ownerQuestions[0];
    const answer: QualificationOwnerAnswer = { questionId: question.id, ownerAgentId: question.ownerAgentId, fieldId: "skills", providerDisclosureConsent: true, answeredAt: new Date().toISOString() };
    await expect(service.qualifyIntroduction({ ...pair, priorState: first, ownerAnswers: [{ ...answer, providerDisclosureConsent: false }] as never })).rejects.toMatchObject({ code: "input" });
    await expect(service.qualifyIntroduction({ ...pair, priorState: first, ownerAnswers: [{ ...answer, ownerAgentId: "test-agent-b" }] })).rejects.toMatchObject({ code: "input" });
    await expect(service.qualifyIntroduction({ ...pair, priorState: first, ownerAnswers: [answer, answer] })).rejects.toMatchObject({ code: "input" });
    expect(fixture.calls).toHaveLength(2);
  });

  it("does not bypass the current allowlist for an explicit owner answer", async () => {
    const fixture = fixtureProvider(data => turn(data, true)), pair = input();
    const first = await new MeetiAgentService(fixture.provider, authorize).qualifyIntroduction(pair);
    pair.left.fields.push({ id: "withheld-answer", label: "Answer", value: "Owner answer", visibility: "private", providerAllowed: true });
    const policy: PolicyAuthorizer = async request => ({ ...(await authorize(request)), allowedFieldIds: ["skills"] });
    const question = first.ownerQuestions[0];
    await expect(new MeetiAgentService(fixture.provider, policy).qualifyIntroduction({ ...pair, priorState: first,
      ownerAnswers: [{ questionId: question.id, ownerAgentId: question.ownerAgentId, fieldId: "withheld-answer", providerDisclosureConsent: true, answeredAt: new Date().toISOString() }] })).rejects.toMatchObject({ code: "policy" });
    expect(fixture.calls).toHaveLength(2);
  });

  it("stops after six actual completions and cannot extend its original total round cap", async () => {
    const fixture = fixtureProvider(data => ({ ...turn(data, true), ownerQuestions: [], peerQuestions: ["Can you clarify from your supplied context?"] }));
    const service = new MeetiAgentService(fixture.provider, authorize), pair = input();
    const result = await service.qualifyIntroduction({ ...pair, maxRounds: 3 });
    expect(result).toMatchObject({ state: "round_limit", stopReason: "bounded_round_limit", round: 3 });
    expect(fixture.calls).toHaveLength(6);
    await expect(service.qualifyIntroduction({ ...pair, priorState: result })).rejects.toMatchObject({ code: "input" });
    expect(fixture.calls).toHaveLength(6);
  });

  it("treats unknown context differently from an explicit mismatch", async () => {
    const missing = fixtureProvider(data => turn(data, true));
    expect((await new MeetiAgentService(missing.provider, authorize).qualifyIntroduction(input())).state).toBe("needs_owner");
    const mismatch = fixtureProvider(data => { const output = turn(data); output.findings[3].status = "contradicted"; return output; });
    const result = await new MeetiAgentService(mismatch.provider, authorize).qualifyIntroduction(input());
    expect(result).toMatchObject({ state: "not_aligned", stopReason: "explicit_mismatch" });
    expect(mismatch.calls).toHaveLength(2);
  });

  it("requires both sides exact evidence for supported mutual criteria", async () => {
    const fixture = fixtureProvider(data => { const output = turn(data); output.findings[0].evidenceReferences = [`${data.self.agentId}:intent:summary`]; return output; });
    await expect(new MeetiAgentService(fixture.provider, authorize).qualifyIntroduction(input())).rejects.toMatchObject({ code: "output" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("rejects fabricated references and incomplete category rubrics", async () => {
    for (const malformed of ["reference", "rubric"]) {
      const fixture = fixtureProvider(data => { const output = turn(data); if (malformed === "reference") output.evidence[0].quote = "not in the source"; else output.findings[3] = { ...output.findings[0] }; return output; });
      await expect(new MeetiAgentService(fixture.provider, authorize).qualifyIntroduction(input())).rejects.toMatchObject({ code: "output" });
      expect(fixture.calls).toHaveLength(1);
    }
  });

  it("stops on revoked authority between turns and changed authority after inference", async () => {
    for (const allowedCalls of [2, 4]) {
      const fixture = fixtureProvider(data => turn(data)); let count = 0;
      const policy: PolicyAuthorizer = async request => ({ ...(await authorize(request)), allowed: ++count <= allowedCalls });
      await expect(new MeetiAgentService(fixture.provider, policy).qualifyIntroduction(input())).rejects.toMatchObject({ code: "policy" });
      expect(fixture.calls).toHaveLength(allowedCalls / 2);
    }
  });

  it("rejects a policy version change during inference and another intent version on resume", async () => {
    const fixture = fixtureProvider(data => turn(data)); let count = 0;
    const policy: PolicyAuthorizer = async request => ({ ...(await authorize(request)), policyVersion: ++count > 4 ? 2 : 1 });
    await expect(new MeetiAgentService(fixture.provider, policy).qualifyIntroduction(input())).rejects.toMatchObject({ code: "policy" });
    const missing = fixtureProvider(data => turn(data, true)), service = new MeetiAgentService(missing.provider, authorize), pair = input();
    const priorState = await service.qualifyIntroduction(pair);
    pair.left.intent.version += 1;
    await expect(service.qualifyIntroduction({ ...pair, priorState })).rejects.toMatchObject({ code: "input" });
    expect(missing.calls).toHaveLength(2);
  });

  it("uses distinct category criteria and rejects incompatible reviewed categories", async () => {
    expect(QUALIFICATION_RUBRICS.cofounder.map(item => item.id)).toContain("commitment_expectations");
    expect(QUALIFICATION_RUBRICS.mentor.map(item => item.id)).toContain("learning_goal");
    expect(QUALIFICATION_RUBRICS.teammate.map(item => item.id)).toContain("coordination_expectations");
    const fixture = fixtureProvider(data => turn(data)), pair = input(); pair.right.intent.goal = "mentor";
    await expect(new MeetiAgentService(fixture.provider, authorize).qualifyIntroduction(pair)).rejects.toMatchObject({ code: "input" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("awaits durable turn persistence and retains the first actual receipt when the second call fails", async () => {
    const persisted: string[] = [];
    const fixture = fixtureProvider((data, index) => {
      if (index === 1) {
        expect(persisted).toEqual(["test-agent-a"]);
        throw new Error("Test-only upstream failure");
      }
      return turn(data);
    });
    await expect(new MeetiAgentService(fixture.provider, authorize).qualifyIntroduction({ ...input(), onProgress: async event => {
      if (event.kind === "turn_completed") {
        expect(event.message.inference.providerRequestId).toBe("test-only-inference");
        persisted.push(event.message.agentId);
        event.message.message = "Mutating a copied progress event cannot change the service transcript.";
      }
    } })).rejects.toThrow("Test-only upstream failure");
    expect(persisted).toEqual(["test-agent-a"]);
    expect(fixture.calls).toHaveLength(2);
  });

  it("emits a validated final state and stops before another call when persistence rejects a turn", async () => {
    const fixture = fixtureProvider(data => turn(data));
    const events: string[] = [];
    const service = new MeetiAgentService(fixture.provider, authorize);
    const result = await service.qualifyIntroduction({ ...input(), onProgress: event => { events.push(event.kind); } });
    expect(result.state).toBe("qualified");
    expect(events).toEqual(["turn_completed", "turn_completed", "state_completed"]);
    const blocked = fixtureProvider(data => turn(data));
    await expect(new MeetiAgentService(blocked.provider, authorize).qualifyIntroduction({ ...input(), onProgress: () => { throw new Error("Test-only persistence unavailable"); } })).rejects.toThrow("Test-only persistence unavailable");
    expect(blocked.calls).toHaveLength(1);
  });
});
