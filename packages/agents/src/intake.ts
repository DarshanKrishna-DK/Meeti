import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentError, type StructuredProvider } from "./provider";

const text = z.string().trim().min(1).max(1000);
const reference = z.string().min(1).max(100);
const citationSchema = z.object({ reference, quote: text }).strict();
const factSchema = z.object({ value: text, sourceReference: reference, sourceQuote: text }).strict();
export const profileIntakeGenerationSchema = z.object({
  summary: text.nullable(), summaryEvidence: z.array(citationSchema).max(6),
  about: factSchema.nullable(), offering: z.array(factSchema).max(6), seeking: z.array(factSchema).max(6),
  tags: z.array(factSchema).max(10), clarificationQuestions: z.array(text).max(3),
}).strict();
const questionSchema = z.object({ id: z.string().uuid(), question: text, round: z.number().int().min(1).max(3), createdAt: z.string().datetime() }).strict();
const answerSchema = z.object({ questionId: z.string().uuid(), text: z.string().trim().min(1).max(3000), providerDisclosureConsent: z.literal(true) }).strict();
const inferenceSchema = z.object({
  requestId: z.string().min(1).max(200), providerRequestId: z.string().max(300).nullable(), model: z.string().min(1).max(200),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(),
}).strict();
export const profileIntakeResultSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  round: z.number().int().min(1).max(3), maxRounds: z.number().int().min(1).max(3),
  state: z.enum(["needs_owner", "ready_for_review", "round_limit"]),
  draft: profileIntakeGenerationSchema, questions: z.array(questionSchema).max(9), answers: z.array(answerSchema).max(9),
  inference: z.array(inferenceSchema).min(1).max(3), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type ProfileIntakeResult = z.infer<typeof profileIntakeResultSchema>;
export type ProfileIntakeAnswer = z.infer<typeof answerSchema>;
export interface ProfileIntakeInput {
  text: string; providerDisclosureConsent: true; maxRounds?: 1 | 2 | 3;
  /** Supply only the current owner private state from authenticated server persistence. */
  priorState?: ProfileIntakeResult;
  answers?: ProfileIntakeAnswer[];
}

/** A private draft from source-backed extraction. This never changes public fields or permissions. */
export async function runProfileIntake(provider: StructuredProvider, input: ProfileIntakeInput): Promise<ProfileIntakeResult> {
  if (input.providerDisclosureConsent !== true) throw new AgentError("policy", "Explicit consent to send profile intake to the configured AI provider is required.");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000) throw new AgentError("input", "Profile intake requires between 1 and 8000 characters.");
  const inputDigest = createHash("sha256").update(input.text).digest("hex");
  const maxRounds = input.maxRounds ?? input.priorState?.maxRounds ?? 3;
  if (![1, 2, 3].includes(maxRounds)) throw new AgentError("input", "Profile intake permits at most three rounds.");
  let prior: ProfileIntakeResult | undefined;
  if (input.priorState) {
    const parsed = profileIntakeResultSchema.safeParse(input.priorState);
    if (!parsed.success) throw new AgentError("input", "The stored profile intake state is invalid.");
    prior = parsed.data;
    if (prior.inputDigest !== inputDigest || prior.maxRounds !== maxRounds || prior.state !== "needs_owner" || prior.round >= maxRounds
      || prior.inference.length !== prior.round) throw new AgentError("input", "Continue only the original unfinished owner intake within its round limit.");
  }
  const suppliedAnswers = z.array(answerSchema).max(9).safeParse(input.answers ?? []);
  if (!suppliedAnswers.success) throw new AgentError("input", "Each intake answer needs a bounded value, immutable question reference, and explicit provider consent.");
  if ((!prior && suppliedAnswers.data.length > 0) || (prior && suppliedAnswers.data.length === 0)) throw new AgentError("input", "A follow-up needs an unanswered stored owner question.");
  const answers = [...(prior?.answers ?? []), ...suppliedAnswers.data];
  if (answers.length > 9 || new Set(answers.map(answer => answer.questionId)).size !== answers.length
    || suppliedAnswers.data.some(answer => !prior?.questions.some(question => question.id === answer.questionId))) {
    throw new AgentError("input", "An intake question accepts one owner answer tied to the original question.");
  }
  const sources = [
    { reference: "intake:initial", value: input.text },
    ...answers.map(answer => ({ reference: `intake:answer:${answer.questionId}`, value: answer.text })),
  ];
  const round = (prior?.round ?? 0) + 1;
  const generated = await provider.generate({
    task: "profile_intake", outputSchema: profileIntakeGenerationSchema,
    data: { sources, priorQuestions: prior?.questions.map(({ id, question }) => ({ id, question })) ?? [], round, maxRounds },
    instructions: 'Return exactly {"summary":null,"summaryEvidence":[],"about":null,"offering":[],"seeking":[],"tags":[],"clarificationQuestions":[]}. Null and empty values in this example show the shape, not a prescribed answer. Extract a compact private profile draft using only the owner explicit statements in sources. A non-null summary must cite exact source substrings through summaryEvidence reference and quote. Every about, offering, seeking and tag item is {"value":"...","sourceReference":"supplied reference","sourceQuote":"exact source substring"}. Do not decorate source quotes with quotation marks. Keep summary under three short sentences. Treat new owner answers as claimed facts that may clarify earlier statements; never invent or verify credentials, identity, contact, employer, availability, compensation, or preferences. Leave unstated details null or empty. Ask at most three concise high-value follow-up questions for missing who-I-am, explicit offer, or desired connection information. Do not ask for contact details. If the supplied information already supports an editable profile draft, stop asking questions. This is a draft for owner review, never public consent, published profile, grant, or verified professional record.',
  });
  const facts = [...generated.output.offering, ...generated.output.seeking, ...generated.output.tags, ...(generated.output.about ? [generated.output.about] : [])];
  for (const fact of facts) {
    const source = sources.find(item => item.reference === fact.sourceReference);
    if (!source || !source.value.includes(fact.sourceQuote)) throw new AgentError("output", "A profile intake fact cited unavailable source text.");
  }
  for (const citation of generated.output.summaryEvidence) {
    const source = sources.find(item => item.reference === citation.reference);
    if (!source || !source.value.includes(citation.quote)) throw new AgentError("output", "The profile summary cited unavailable source text.");
  }
  if ((generated.output.summary !== null && generated.output.summaryEvidence.length === 0)
    || (generated.output.summary === null && generated.output.summaryEvidence.length > 0)
    || (facts.length === 0 && generated.output.clarificationQuestions.length === 0)) {
    throw new AgentError("output", "A profile draft needs source-backed content or explicit owner clarification.");
  }
  const timestamp = new Date().toISOString();
  const questions = [...(prior?.questions ?? []), ...generated.output.clarificationQuestions.map(question => ({ id: randomUUID(), question, round, createdAt: timestamp }))];
  const pending = generated.output.clarificationQuestions.length > 0;
  return profileIntakeResultSchema.parse({ schemaVersion: 1, id: prior?.id ?? randomUUID(), inputDigest, round, maxRounds,
    state: pending ? (round >= maxRounds ? "round_limit" : "needs_owner") : "ready_for_review",
    draft: generated.output, questions, answers, inference: [...(prior?.inference ?? []), generated.inference],
    createdAt: prior?.createdAt ?? timestamp, updatedAt: timestamp });
}
