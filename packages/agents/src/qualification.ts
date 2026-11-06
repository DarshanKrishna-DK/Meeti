import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentError, type InferenceReservation, type StructuredProvider } from "./provider";
import type { AgentParticipant, DisclosureCheck, PolicyReceipt } from "./service";

const shortText = z.string().trim().min(1).max(700);
const identifier = z.string().min(1).max(200);
const evidenceSchema = z.object({ reference: z.string().min(1).max(350), quote: shortText }).strict();
const criterionSchema = z.object({
  id: identifier, description: shortText, essential: z.boolean(),
}).strict();
export type QualificationCriterion = z.infer<typeof criterionSchema>;

/** Criteria describe missing context. They never establish identity, credentials, or permission. */
export const QUALIFICATION_RUBRICS: Record<AgentParticipant["intent"]["goal"], readonly QualificationCriterion[]> = {
  collaborator: [
    { id: "shared_objective", description: "The stated collaboration objectives fit each other.", essential: true },
    { id: "reciprocal_contribution", description: "Each owner explicitly offers a contribution relevant to the other owner stated need.", essential: true },
    { id: "scope_expectations", description: "The expected contribution and collaboration scope are sufficiently stated without assuming compensation or obligations.", essential: true },
    { id: "constraints", description: "Explicit constraints are compatible. Missing availability or location is unknown rather than an assumed conflict.", essential: false },
  ],
  cofounder: [
    { id: "shared_direction", description: "The owners explicitly describe compatible venture direction and motivation.", essential: true },
    { id: "complementary_contribution", description: "Each owner stated contribution addresses the other owner stated founding needs.", essential: true },
    { id: "commitment_expectations", description: "Commitment expectations are explicit enough to discuss a founding relationship without inventing time, money, or equity terms.", essential: true },
    { id: "decision_expectations", description: "Any stated decision, responsibility, or risk expectations are compatible; absent terms remain unknown.", essential: false },
  ],
  mentor: [
    { id: "learning_goal", description: "The intended learner and help offered fit an explicitly stated learning goal.", essential: true },
    { id: "relevant_experience", description: "The proposed mentor explicitly claims experience relevant to the stated goal. A claim is not a verified credential.", essential: true },
    { id: "relationship_expectations", description: "The requested and offered mentorship scope fit without assuming an ongoing obligation.", essential: true },
    { id: "constraints", description: "Explicit communication or availability constraints fit; absent constraints remain unknown.", essential: false },
  ],
  teammate: [
    { id: "team_goal", description: "Both owners describe a compatible team objective or event context.", essential: true },
    { id: "role_contribution", description: "The owner stated skills and desired roles provide a mutually useful team contribution.", essential: true },
    { id: "coordination_expectations", description: "The team participation and coordination expectations are sufficiently explicit without inventing a schedule.", essential: true },
    { id: "constraints", description: "Explicit team, event, or availability constraints fit; absent constraints remain unknown.", essential: false },
  ],
};

const findingSchema = z.object({
  criterionId: identifier, status: z.enum(["supported", "contradicted", "unknown"]),
  explanation: shortText, evidenceReferences: z.array(z.string().min(1).max(350)).max(6),
}).strict();
const questionGenerationSchema = z.object({
  owner: z.enum(["self", "other"]), criterionIds: z.array(identifier).min(1).max(4), question: shortText,
}).strict();

/** A shallow strict generation shape for providers that reject deeply nested response schemas. */
export const qualificationTurnSchema = z.object({
  message: shortText,
  findings: z.array(findingSchema).length(4),
  peerQuestions: z.array(shortText).max(2),
  ownerQuestions: z.array(questionGenerationSchema).max(3),
  requestedFieldIds: z.array(z.string().min(1).max(100)).max(3),
  evidence: z.array(evidenceSchema).min(1).max(6),
}).strict();

const bindingSchema = z.object({
  agentId: identifier, intentId: identifier, intentVersion: z.number().int().positive(),
  goal: z.enum(["collaborator", "cofounder", "mentor", "teammate"]),
}).strict();
const inferenceSchema = z.object({
  requestId: identifier, providerRequestId: z.string().max(300).nullable(), model: identifier,
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
}).strict();
const messageSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), agentId: identifier, round: z.number().int().min(1).max(3), createdAt: z.string().datetime(),
  projectionDigest: z.string().regex(/^[a-f0-9]{64}$/), message: shortText,
  findings: z.array(findingSchema).min(1).max(4), peerQuestions: z.array(shortText).max(2),
  requestedFieldIds: z.array(z.string().min(1).max(100)).max(3), evidence: z.array(evidenceSchema).min(1).max(6),
  inference: inferenceSchema,
}).strict();
const ownerQuestionSchema = z.object({
  id: z.string().uuid(), ownerAgentId: identifier, askedByAgentId: identifier,
  question: shortText, criterionIds: z.array(identifier).min(1).max(4),
  evidence: z.array(evidenceSchema).min(1).max(6), round: z.number().int().min(1).max(3), createdAt: z.string().datetime(),
}).strict();
const answerSchema = z.object({
  questionId: z.string().uuid(), ownerAgentId: identifier, fieldId: z.string().min(1).max(100),
  answeredAt: z.string().datetime(), providerDisclosureConsent: z.literal(true),
}).strict();
const policyReceiptSchema = z.object({
  allowed: z.boolean(), reason: z.string().max(1500), policyVersion: z.number().int().positive(),
  allowedFieldIds: z.array(z.string().max(100)).max(60), checkedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
const disclosureCheckSchema = z.object({
  requesterAgentId: identifier, ownerAgentId: identifier, fieldId: z.string().max(100), allowed: z.boolean(),
  reason: z.string().max(1500), policyVersion: z.number().int().positive(),
}).strict();

export const qualificationResultSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), purpose: z.string().min(1).max(200),
  state: z.enum(["qualified", "not_aligned", "needs_owner", "round_limit"]),
  stopReason: z.enum(["mutual_criteria_supported", "explicit_mismatch", "owner_information_required", "bounded_round_limit"]),
  round: z.number().int().min(1).max(3), maxRounds: z.number().int().min(1).max(3),
  participantBindings: z.tuple([bindingSchema, bindingSchema]), rubric: z.array(criterionSchema).min(1).max(4),
  messages: z.array(messageSchema).min(2).max(6), ownerQuestions: z.array(ownerQuestionSchema).max(18),
  answers: z.array(answerSchema).max(18), policyChecks: z.array(policyReceiptSchema).max(96),
  disclosureChecks: z.array(disclosureCheckSchema).max(18), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type QualificationResult = z.infer<typeof qualificationResultSchema>;
export const qualificationCheckpointSchema = qualificationResultSchema.omit({ state: true, stopReason: true }).extend({
  messages: z.array(messageSchema).max(6),
}).strict();
export type QualificationCheckpoint = z.infer<typeof qualificationCheckpointSchema>;
export type QualificationMessage = z.infer<typeof messageSchema>;
export type QualificationOwnerQuestion = z.infer<typeof ownerQuestionSchema>;
export type QualificationOwnerAnswer = z.infer<typeof answerSchema>;
export type QualificationProgress = {
  kind: "turn_completed"; qualificationId: string; schemaVersion: 1;
  round: number; maxRounds: number;
  participantBindings: QualificationResult["participantBindings"];
  message: QualificationMessage; ownerQuestions: QualificationOwnerQuestion[]; policyChecks: PolicyReceipt[];
  checkpoint?: QualificationCheckpoint;
} | {
  kind: "disclosure_checked"; qualificationId: string; schemaVersion: 1; check: DisclosureCheck;
  checkpoint?: QualificationCheckpoint;
} | {
  kind: "state_completed"; qualificationId: string; schemaVersion: 1; result: QualificationResult;
};
export interface QualificationInput {
  left: AgentParticipant; right: AgentParticipant; purpose: string; maxRounds?: 1 | 2 | 3;
  /** Read only from authenticated, tenant-scoped server persistence. Never accept a client-authored transcript. */
  priorState?: QualificationResult;
  /** Encrypted server checkpoint only. Interrupted turns resume without repeating completed messages. */
  checkpoint?: QualificationCheckpoint;
  beforeInference?: (reservation: InferenceReservation, checkpoint: QualificationCheckpoint) => void | Promise<void>;
  /** Answer text exists only in an independently authorized current participant field. */
  ownerAnswers?: QualificationOwnerAnswer[];
  /** Server-only durable persistence callback. It is awaited before another actual provider call. */
  onProgress?: (event: QualificationProgress) => void | Promise<void>;
}
export interface QualificationProjection {
  agentId: string; intentId: string; intentVersion: number; goal: AgentParticipant["intent"]["goal"];
  direction?: AgentParticipant["intent"]["direction"];
  evidence: { reference: string; value: string }[];
}
interface QualificationDependencies {
  project(owner: AgentParticipant, viewer: AgentParticipant): Promise<{ projection: QualificationProjection; receipt: PolicyReceipt }>;
  checkDisclosure(requester: AgentParticipant, owner: AgentParticipant, fieldId: string): Promise<DisclosureCheck>;
}

const qualificationOutputMessages = {
  evidence: "Qualification cited unavailable or unsupported evidence.",
  criteria: "Qualification must assess each supplied category criterion exactly once.",
  finding_citations: "A qualification finding needs its exact supplied evidence citations.",
  bilateral_evidence: "A supported mutual criterion must cite evidence from both participants.",
  owner_questions: "Owner questions must identify an unresolved supplied criterion.",
} as const;
type QualificationValidationDetail = keyof typeof qualificationOutputMessages;
export type QualificationOutputDiagnostic = QualificationValidationDetail | "provider_response_schema" | "provider_incomplete_result"
  | "provider_task_schema" | "provider_response_size" | "provider_empty_response";
class QualificationOutputError extends AgentError {
  constructor(readonly detailCode: QualificationValidationDetail) {
    super("output", qualificationOutputMessages[detailCode]);
    this.name = "QualificationOutputError";
  }
}

/** Fixed diagnostic categories only. Never return model text, source quotes, identifiers, or provider bodies. */
export function qualificationOutputDiagnostic(error: unknown): QualificationOutputDiagnostic | null {
  if (error instanceof QualificationOutputError) return error.detailCode;
  if (!(error instanceof AgentError) || error.code !== "output") return null;
  switch (error.message) {
    case "The AI provider response did not match the required completion schema.": return "provider_response_schema";
    case "The AI provider did not return a complete structured result.": return "provider_incomplete_result";
    case "The AI result did not match the required task schema.": return "provider_task_schema";
    case "The AI response exceeded its size limit.": return "provider_response_size";
    case "The AI provider returned an empty response.": return "provider_empty_response";
    default: return null;
  }
}

function fail(message: string): never { throw new AgentError("input", message); }
function digest(projections: QualificationProjection[], receipts: PolicyReceipt[]): string {
  const bound = projections.map((projection, index) => ({ projection,
    policyVersion: receipts[index].policyVersion,
  })).sort((a, b) => a.projection.agentId.localeCompare(b.projection.agentId));
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
}
function binding(participant: AgentParticipant) {
  return { agentId: participant.agentId, intentId: participant.intent.id, intentVersion: participant.intent.version, goal: participant.intent.goal };
}
function assertEvidence(evidence: z.infer<typeof evidenceSchema>[], sources: QualificationProjection["evidence"]) {
  for (const item of evidence) {
    const source = sources.find(entry => entry.reference === item.reference);
    if (!source || !source.value.includes(item.quote)) throw new QualificationOutputError("evidence");
  }
}
function assertFindings(output: z.infer<typeof qualificationTurnSchema>, rubric: readonly QualificationCriterion[], sources: QualificationProjection[]) {
  const ids = output.findings.map(finding => finding.criterionId);
  if (new Set(ids).size !== rubric.length || rubric.some(criterion => !ids.includes(criterion.id))) {
    throw new QualificationOutputError("criteria");
  }
  const references = new Set(output.evidence.map(item => item.reference));
  for (const finding of output.findings) {
    if (finding.evidenceReferences.some(reference => !references.has(reference))
      || (finding.status !== "unknown" && finding.evidenceReferences.length === 0)) {
      throw new QualificationOutputError("finding_citations");
    }
    if (finding.status === "supported" && !sources.every(source => finding.evidenceReferences.some(reference => source.evidence.some(item => item.reference === reference)))) {
      throw new QualificationOutputError("bilateral_evidence");
    }
  }
  for (const question of output.ownerQuestions) {
    if (new Set(question.criterionIds).size !== question.criterionIds.length
      || question.criterionIds.some(id => !output.findings.some(finding => finding.criterionId === id && finding.status === "unknown"))) {
      throw new QualificationOutputError("owner_questions");
    }
  }
}

/** Runs actual provider turns. The resulting recommendation cannot release a proposal or room. */
export async function runQualification(provider: StructuredProvider, input: QualificationInput, dependencies: QualificationDependencies): Promise<QualificationResult> {
  const { left, right } = input;
  if (left.intent.goal !== right.intent.goal) fail("Qualification requires the same reviewed networking category for both owners.");
  const purpose = z.string().trim().min(1).max(200).safeParse(input.purpose);
  if (!purpose.success) fail("Qualification requires a bounded purpose.");
  const maxRounds = input.maxRounds ?? input.checkpoint?.maxRounds ?? input.priorState?.maxRounds ?? 3;
  if (![1, 2, 3].includes(maxRounds)) fail("Qualification permits at most three rounds in total.");
  const jobPair = [left.intent.direction, right.intent.direction].includes('seeking-job') && [left.intent.direction, right.intent.direction].includes('hiring');
  const helpPair = [left.intent.direction, right.intent.direction].includes('seeking-help') && [left.intent.direction, right.intent.direction].includes('offering-expertise');
  const rubric = (jobPair ? [
    { id: 'role_relevance', description: 'The explicitly offered role and the job seeker stated professional interests fit both owners. Do not invent a vacancy or experience.', essential: true },
    { id: 'required_evidence', description: 'Explicit mandatory role requirements have relevant self-claimed evidence. Missing evidence remains unknown and self-claims are not verified credentials.', essential: true },
    { id: 'mutual_expectations', description: 'The owners explicitly state sufficiently compatible recruiting and job-seeking expectations. Do not invent compensation, employment terms or commitments.', essential: true },
    { id: 'constraints', description: 'Explicit location, availability, seniority or compensation constraints are compatible; missing optional terms remain unknown.', essential: false },
  ] : helpPair ? [
    { id: 'help_goal', description: 'The explicitly requested help and offered expertise concern a mutually relevant objective.', essential: true },
    { id: 'relevant_expertise', description: 'The offering owner explicitly claims expertise relevant to the requested help. This is a self-claim, never an independently verified credential.', essential: true },
    { id: 'help_scope', description: 'The explicitly requested and offered help scopes fit without assuming compensation, reciprocal work or an ongoing mentorship obligation.', essential: true },
    { id: 'constraints', description: 'Explicit constraints fit. Missing optional location or availability is unknown, not an assumed conflict.', essential: false },
  ] : QUALIFICATION_RUBRICS[left.intent.goal]).map(criterion => ({ ...criterion }));
  const participantBindings = [binding(left), binding(right)] as const;
  let prior: QualificationResult | undefined;
  let checkpoint: QualificationCheckpoint | undefined;
  if (input.checkpoint) {
    if (input.priorState) fail("Use one stored qualification continuation only.");
    const parsed = qualificationCheckpointSchema.safeParse(input.checkpoint);
    if (!parsed.success) fail("The stored interrupted qualification is invalid.");
    checkpoint = parsed.data;
    if (checkpoint.purpose !== purpose.data || JSON.stringify(checkpoint.participantBindings) !== JSON.stringify(participantBindings)
      || JSON.stringify(checkpoint.rubric) !== JSON.stringify(rubric) || checkpoint.maxRounds !== maxRounds
      || checkpoint.messages.length < (checkpoint.round - 1) * 2 || checkpoint.messages.length > checkpoint.round * 2
      || checkpoint.messages.some((message, index) => message.round !== Math.floor(index / 2) + 1 || message.agentId !== participantBindings[index % 2].agentId)) {
      fail("The interrupted qualification is inconsistent with its original participants and turn order.");
    }
  }
  if (input.priorState) {
    const parsed = qualificationResultSchema.safeParse(input.priorState);
    if (!parsed.success) fail("The stored qualification state is invalid.");
    prior = parsed.data;
    if (prior.purpose !== purpose.data || JSON.stringify(prior.participantBindings) !== JSON.stringify(participantBindings)
      || JSON.stringify(prior.rubric) !== JSON.stringify(rubric) || prior.maxRounds !== maxRounds) {
      fail("Qualification state is bound to its original owners, intents, category, purpose, and round limit.");
    }
    if (prior.state !== "needs_owner" || prior.round >= maxRounds) fail("This qualification is complete or has reached its round limit.");
    if (prior.messages.length !== prior.round * 2 || prior.messages.some((message, index) => message.round !== Math.floor(index / 2) + 1
      || message.agentId !== participantBindings[index % 2].agentId)) fail("The stored qualification transcript is inconsistent.");
  }
  const parsedAnswers = z.array(answerSchema).max(18).safeParse(input.ownerAnswers ?? []);
  if (!parsedAnswers.success) fail("Owner answers require immutable question references and explicit provider disclosure consent.");
  const saved = checkpoint ?? prior;
  if (!saved && parsedAnswers.data.length) fail("Answers require a stored qualification question.");
  const answers = [...(saved?.answers ?? []), ...parsedAnswers.data];
  if (answers.length > 18 || new Set(answers.map(answer => answer.questionId)).size !== answers.length) fail("Each owner question accepts one immutable answer.");
  for (const answer of parsedAnswers.data) {
    const question = saved?.ownerQuestions.find(item => item.id === answer.questionId);
    const owner = [left, right].find(item => item.agentId === answer.ownerAgentId);
    const field = owner?.fields.find(item => item.id === answer.fieldId);
    if (!question || question.ownerAgentId !== answer.ownerAgentId || !field || field.providerAllowed !== true
      || Date.parse(answer.answeredAt) < Date.parse(question.createdAt) || Date.parse(answer.answeredAt) > Date.now() + 1000) {
      fail("An answer must be owner-bound, current, explicitly provider-approved, and linked to a stored question.");
    }
  }
  if (prior && !parsedAnswers.data.length) fail("Continue qualification only after a new owner answer.");
  const messages: QualificationMessage[] = [...(saved?.messages ?? [])];
  const ownerQuestions: QualificationOwnerQuestion[] = [...(saved?.ownerQuestions ?? [])];
  const policyChecks: PolicyReceipt[] = [...(saved?.policyChecks ?? [])];
  const disclosureChecks: DisclosureCheck[] = [...(saved?.disclosureChecks ?? [])];
  const id = saved?.id ?? randomUUID();
  const createdAt = saved?.createdAt ?? new Date().toISOString();
  let state: QualificationResult["state"] = "round_limit";
  let stopReason: QualificationResult["stopReason"] = "bounded_round_limit";
  let round = checkpoint ? checkpoint.round - 1 : prior?.round ?? 0;
  const snapshot = (): QualificationCheckpoint => qualificationCheckpointSchema.parse({ schemaVersion: 1, id, purpose: purpose.data,
    round, maxRounds, participantBindings, rubric, messages, ownerQuestions, answers, policyChecks, disclosureChecks, createdAt, updatedAt: new Date().toISOString() });
  while (round < maxRounds) {
    round += 1;
    for (const [self, other] of [[left, right], [right, left]]) {
      const own = await dependencies.project(self, other);
      const peer = await dependencies.project(other, self);
      policyChecks.push(own.receipt, peer.receipt);
      const projections = [own.projection, peer.projection];
      const projectionDigest = digest(projections, [own.receipt, peer.receipt]);
      const availableEvidence = projections.flatMap(projection => projection.evidence);
      const completed = messages.find(message => message.round === round && message.agentId === self.agentId);
      if (completed) {
        if (completed.projectionDigest !== projectionDigest) throw new AgentError("policy", "The saved qualification projection is no longer authorized.");
        assertEvidence(completed.evidence, availableEvidence);
        continue;
      }
      const answerReferences = answers.map(answer => ({
        questionId: answer.questionId,
        ownerAgentId: answer.ownerAgentId,
        reference: `${answer.ownerAgentId}:field:${answer.fieldId}`,
        criterionIds: ownerQuestions.find(question => question.id === answer.questionId)?.criterionIds ?? [],
      }));
      if (answerReferences.some(answer => !availableEvidence.some(evidence => evidence.reference === answer.reference))) {
        throw new AgentError("policy", "A qualification answer is outside the current disclosure allowlist.");
      }
      const priorPeerMessages = messages.filter(message => message.agentId === other.agentId && message.projectionDigest === projectionDigest)
        .slice(-2).map(({ id: messageId, message, peerQuestions, findings }) => ({ id: messageId, message, peerQuestions, findings }));
      const outputShape = { message: "Your evidence-grounded message to the peer agent",
        findings: rubric.map(criterion => ({ criterionId: criterion.id, status: "unknown", explanation: "Explain the finding using current supplied evidence", evidenceReferences: [] })),
        peerQuestions: [], ownerQuestions: [], requestedFieldIds: [], evidence: [{ reference: "exact supplied reference", quote: "exact current source substring" }] };
      const generated = await provider.generate({
        task: "qualification_turn", outputSchema: qualificationTurnSchema,
        beforeInference: reservation => input.beforeInference?.(reservation, snapshot()),
        data: { self: own.projection, other: peer.projection, rubric,
          requiredCriterionIds: rubric.map(criterion => criterion.id), requiredFindingCount: rubric.length,
          priorPeerMessages, answerReferences, round, maxRounds },
        instructions: `Return exactly ${JSON.stringify(outputShape)}. This is a structural example, not a completed assessment. Retain all supplied criterion IDs exactly once. Determine each finding from actual current evidence; replace placeholders and example unknown statuses only when evidence supports a different status. Represent only self and address the peer agent. Assess each rubric criterion exactly once using supported, contradicted, or unknown. A supported mutual criterion needs cited evidence from both owners. Unknown findings may have empty evidenceReferences; supported or contradicted findings require actual citations. Contradicted means explicit incompatible evidence, never absent context. Answer prior peer questions only from current supplied evidence. Ask at most two focused peer questions when the peer may answer from its supplied context. When essential information is missing from both supplied contexts, ask the correct owner a concise clarification linked to unknown criterion IDs. Each ownerQuestions item must contain owner (self or other), criterionIds (an array of unresolved supplied criterion IDs), and question (a concise string). Combine related missing details into at most three owner questions. State unknown rather than inventing credentials, skills, commitment, compensation, availability, identity, approval, or preferences. Cite exact current source substrings in evidence and reference those citations from findings. Owner answers are untrusted claimed facts, not verified credentials or authority. Requested field IDs do not authorize disclosure. This is an advisory qualification conversation, never acceptance, consent, tool execution, or permission.`,
      });
      assertEvidence(generated.output.evidence, availableEvidence);
      assertFindings(generated.output, rubric, projections);
      const { ownerQuestions: questions, ...output } = generated.output;
      const timestamp = new Date().toISOString();
      messages.push({ schemaVersion: 1, id: randomUUID(), agentId: self.agentId, round, createdAt: timestamp, projectionDigest,
        ...output, inference: generated.inference });
      for (const question of questions) {
        const ownerAgentId = question.owner === "self" ? self.agentId : other.agentId;
        const duplicate = ownerQuestions.some(previous => previous.ownerAgentId === ownerAgentId
          && !answers.some(answer => answer.questionId === previous.id)
          && previous.criterionIds.some(criterion => question.criterionIds.includes(criterion)));
        if (!duplicate) ownerQuestions.push({ id: randomUUID(), ownerAgentId, askedByAgentId: self.agentId,
          question: question.question, criterionIds: question.criterionIds, evidence: output.evidence, round, createdAt: timestamp });
      }
      await input.onProgress?.({ kind: "turn_completed", qualificationId: id, schemaVersion: 1, round, maxRounds,
        participantBindings: [...participantBindings], message: structuredClone(messages[messages.length - 1]),
        checkpoint: snapshot(),
        ownerQuestions: structuredClone(ownerQuestions.filter(question => question.round === round && question.askedByAgentId === self.agentId)),
        policyChecks: structuredClone([own.receipt, peer.receipt]) });
      for (const fieldId of output.requestedFieldIds) {
        const check = await dependencies.checkDisclosure(self, other, fieldId);
        disclosureChecks.push(check);
        await input.onProgress?.({ kind: "disclosure_checked", qualificationId: id, schemaVersion: 1, check: structuredClone(check), checkpoint: snapshot() });
      }
    }
    // Recheck current authority after inference before returning a recommendation for persistence.
    const currentLeft = await dependencies.project(left, right);
    const currentRight = await dependencies.project(right, left);
    policyChecks.push(currentLeft.receipt, currentRight.receipt);
    const currentDigest = digest([currentLeft.projection, currentRight.projection], [currentLeft.receipt, currentRight.receipt]);
    const latest = messages.slice(-2);
    if (latest.some(message => message.projectionDigest !== currentDigest)) {
      throw new AgentError("policy", "The qualification disclosure projection changed during inference.");
    }
    const essential = latest.flatMap(message => message.findings.filter(finding => rubric.some(criterion => criterion.id === finding.criterionId && criterion.essential)));
    if (latest.some(message => message.findings.some(finding => finding.status === "contradicted"))) { state = "not_aligned"; stopReason = "explicit_mismatch"; break; }
    // Unknown material findings are owner tasks, not an excuse for repeated identical provider calls.
    // No owner role is guessed from prose. When no model owner question identifies the addressee,
    // ask each owner about their own side of the mutual criterion, never about the peer private facts.
    if (round < maxRounds) {
      const unaddressed = rubric.filter(criterion => criterion.essential && latest.some(message => message.findings.some(finding => finding.criterionId === criterion.id && finding.status === "unknown"))
        && !ownerQuestions.some(question => question.criterionIds.includes(criterion.id) && !answers.some(answer => answer.questionId === question.id)));
      if (unaddressed.length) for (const owner of [left, right]) {
        const message = latest.find(item => item.agentId === owner.agentId)!;
        ownerQuestions.push({ id: randomUUID(), ownerAgentId: owner.agentId, askedByAgentId: owner.agentId,
          question: `Backend clarification: add only your own facts or unanswered questions for ${unaddressed.map(criterion => criterion.id).join(', ')}. Your agent could not establish these mutual criteria. Do not guess the other person details.`,
          criterionIds: unaddressed.map(criterion => criterion.id), evidence: message.evidence, round, createdAt: new Date().toISOString() });
      }
    }
    const pendingQuestions = ownerQuestions.filter(question => !answers.some(answer => answer.questionId === question.id));
    if (essential.every(finding => finding.status === "supported") && pendingQuestions.length === 0) {
      state = "qualified"; stopReason = "mutual_criteria_supported"; break;
    }
    if (pendingQuestions.length && round < maxRounds) { state = "needs_owner"; stopReason = "owner_information_required"; break; }
  }
  const result = qualificationResultSchema.parse({ schemaVersion: 1, id, purpose: purpose.data, state, stopReason, round, maxRounds,
    participantBindings, rubric, messages, ownerQuestions, answers, policyChecks, disclosureChecks, createdAt, updatedAt: new Date().toISOString() });
  await input.onProgress?.({ kind: "state_completed", qualificationId: id, schemaVersion: 1, result: structuredClone(result) });
  return result;
}
