import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MeetiAgentService, type StructuredProvider } from "../src";

const initial = "I build TypeScript interfaces and seek a designer for an accessible app.";
const draft = () => ({ summary: "Builds TypeScript interfaces and seeks a designer.",
  summaryEvidence: [{ reference: "intake:initial", quote: "build TypeScript interfaces" }, { reference: "intake:initial", quote: "seek a designer" }],
  about: { value: "Builds interfaces", sourceReference: "intake:initial", sourceQuote: "build TypeScript interfaces" },
  offering: [{ value: "TypeScript interfaces", sourceReference: "intake:initial", sourceQuote: "TypeScript interfaces" }],
  seeking: [{ value: "A designer", sourceReference: "intake:initial", sourceQuote: "seek a designer" }], tags: [], clarificationQuestions: [],
});
function fixtureProvider(output: (data: { round: number; sources: { reference: string; value: string }[] }) => unknown) {
  const calls: unknown[] = [];
  const provider: StructuredProvider = { async generate<T>(request: { data: unknown; outputSchema: z.ZodType<T> }) {
    calls.push(request.data);
    return { output: request.outputSchema.parse(output(request.data as never)), inference: {
      requestId: crypto.randomUUID(), providerRequestId: "test-only-intake", model: "test-only-model", inputTokens: 1, outputTokens: 1,
      estimatedCostUsd: 0, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    } };
  } };
  return { calls, service: new MeetiAgentService(provider, async () => { throw new Error("Profile intake cannot grant networking authority."); }) };
}

describe("private bounded profile intake with test-only providers", () => {
  it("returns an owner-reviewed source-backed compact draft without inventing missing profile fields", async () => {
    const fixture = fixtureProvider(draft);
    const result = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true });
    expect(result).toMatchObject({ state: "ready_for_review", round: 1, draft: { about: { sourceQuote: "build TypeScript interfaces" } } });
    expect(result.inference).toHaveLength(1);
    expect(result.draft).not.toHaveProperty("employer");
  });

  it("links a real follow-up completion to the original owner question and retained source references", async () => {
    const fixture = fixtureProvider(data => data.round === 1 ? { ...draft(), clarificationQuestions: ["What interface work would you like to contribute?"] }
      : { ...draft(), offering: [{ value: "Build a keyboard interface", sourceReference: data.sources[1].reference, sourceQuote: "Build a keyboard interface" }] });
    const first = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true });
    const second = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true, priorState: first,
      answers: [{ questionId: first.questions[0].id, text: "Build a keyboard interface", providerDisclosureConsent: true }] });
    expect(second).toMatchObject({ id: first.id, state: "ready_for_review", round: 2 });
    expect(second.inference).toHaveLength(2);
    expect(second.answers[0].questionId).toBe(first.questions[0].id);
    expect(fixture.calls).toHaveLength(2);
  });

  it("requires consent, immutable question references, and original source text before another provider call", async () => {
    const fixture = fixtureProvider(() => ({ ...draft(), clarificationQuestions: ["What do you want to contribute?"] }));
    await expect(fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: false } as never)).rejects.toMatchObject({ code: "policy" });
    const first = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true });
    const answers = [{ questionId: crypto.randomUUID(), text: "A keyboard interface", providerDisclosureConsent: true as const }];
    await expect(fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true, priorState: first, answers })).rejects.toMatchObject({ code: "input" });
    await expect(fixture.service.continueProfileIntake({ text: "Changed profile", providerDisclosureConsent: true, priorState: first, answers })).rejects.toMatchObject({ code: "input" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("rejects unsupported summary evidence and unsupported facts rather than repairing output", async () => {
    for (const malformed of ["summary", "fact", "uncited"]) {
      const fixture = fixtureProvider(() => { const output = draft(); if (malformed === "summary") output.summaryEvidence[0].quote = "Invented credential";
        else if (malformed === "fact") output.offering[0].sourceQuote = "Invented skill"; else output.summaryEvidence = []; return output; });
      await expect(fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true })).rejects.toMatchObject({ code: "output" });
      expect(fixture.calls).toHaveLength(1);
    }
  });

  it("stops at the total round cap and refuses answer replay", async () => {
    const fixture = fixtureProvider(() => ({ ...draft(), clarificationQuestions: ["What app work is in scope?"] }));
    const first = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true, maxRounds: 2 });
    const answers = [{ questionId: first.questions[0].id, text: "Only the interface", providerDisclosureConsent: true as const }];
    const second = await fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true, priorState: first, answers });
    expect(second).toMatchObject({ state: "round_limit", round: 2, maxRounds: 2 });
    await expect(fixture.service.continueProfileIntake({ text: initial, providerDisclosureConsent: true, priorState: second, answers })).rejects.toMatchObject({ code: "input" });
    expect(fixture.calls).toHaveLength(2);
  });
});
