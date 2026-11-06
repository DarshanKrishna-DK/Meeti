import { keccak256, stringToHex } from 'viem';
import type { Action, Agent, Intent, Policy } from '../shared/src';
import { agent, audit, profile, saveAgent } from './db';
import { HttpError } from './security';
import { createEnsAuthorityProvider } from '../ens';
import { createArkivAdapter, type PublicIntent } from '../arkiv/src';
import { createProviderFromEnv, MeetiAgentService, type AgentParticipant } from '../agents/src';
import { IntentSemanticsSchema } from '../matching/src/semantics';
import { approvedContextFields, contextFieldAllowed } from './context-policy';
import { qualificationAnswerAllowed } from './qualification-context';

export function policyDigest(policy: Policy): `0x${string}` {
  return keccak256(stringToHex(JSON.stringify({ version: policy.version, purpose: policy.purpose,
    allowedFields: [...policy.allowedFields].sort(), allowedActions: [...policy.allowedActions].sort(),
    expiresAt: policy.expiresAt, paused: policy.paused })));
}
export function ensProvider(value: Agent) {
  if (!process.env.ENS_SEPOLIA_RPC_URL) throw new HttpError(503, 'ENS_UNCONFIGURED', 'Configure the Sepolia RPC connection before verifying agent permissions.');
  return createEnsAuthorityProvider({ rpcUrl: process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL, namespace: {
    ensName: value.ensName, owner: value.owner as `0x${string}`, delegate: value.delegate as `0x${string}`,
    resolverAddress: String(value.config.resolverAddress || '') as `0x${string}`, policyDigest: policyDigest(value.policy),
  } });
}
export async function authority(userId: string, action: Action, expectedPolicy?: number) {
  const value = agent(userId);
  if (!value) throw new HttpError(409, 'AGENT_REQUIRED', 'Set up your agent before continuing.');
  if (value.policy.paused) throw new HttpError(403, 'AGENT_PAUSED', 'Your agent is paused.');
  if (Date.parse(value.policy.expiresAt) <= Date.now()) throw new HttpError(403, 'POLICY_EXPIRED', 'Your agent permissions have expired.');
  if (!value.policy.allowedActions.includes(action)) throw new HttpError(403, 'ACTION_DENIED', 'Your current policy does not permit this action.');
  if (expectedPolicy && value.policy.version !== expectedPolicy) throw new HttpError(409, 'POLICY_CHANGED', 'The permission policy has changed. Review this action again.');
  const result = await ensProvider(value).checkAuthority({ ensName: value.ensName, owner: value.owner as `0x${string}`,
    delegate: value.delegate as `0x${string}`, action, policyVersion: String(value.policy.version) });
  const current = agent(userId);
  if (!current || policyDigest(current.policy) !== policyDigest(value.policy)) throw new HttpError(409, 'POLICY_CHANGED', 'The permission policy changed during verification.');
  const receipt = { allowed: result.allowed, reason: result.reason, checkedAt: new Date().toISOString(), evidence: result };
  saveAgent(userId, { ...current, authority: receipt });
  if (!result.allowed) {
    audit(userId, action, 'denied', result.reason);
    if (['ens_verification_failed', 'ens_unavailable', 'stale_chain_head'].includes(result.reason)) throw new HttpError(503, 'ENS_VERIFICATION_UNAVAILABLE', 'Current ENS verification could not be completed. Retry when the connection is available; no authority has been assumed.');
    throw new HttpError(403, 'ENS_AUTHORITY_DENIED', result.reason);
  }
  return value;
}
export function assertIntent(value: Intent) {
  if (value.status !== 'published' || Date.parse(value.expiresAt) <= Date.now()) throw new HttpError(409, 'INTENT_INACTIVE', 'This networking intent is no longer active.');
}
export function publicIntent(value: Intent, agent: Agent): PublicIntent {
  const semantics = IntentSemanticsSchema.safeParse(value.semantics);
  if (!semantics.success) throw new HttpError(409, 'INTENT_INTERPRETATION_REQUIRED', 'Interpret and review the relationship direction before publishing this intent.');
  return { intentId: value.id, ensAgentRef: agent.ensName, goal: value.goal, summary: value.summary,
    tags: value.tags, visibility: 'public', optIn: value.publicStatus !== 'closed', status: value.publicStatus || 'active', schemaVersion: 2, semantics: semantics.data, owner: agent.owner, version: value.version,
    policyVersion: value.policyVersion, createdAt: value.createdAt, expiresAt: value.expiresAt, demoOrigin: value.demoOrigin };
}
export function arkiv() {
  if (!process.env.ARKIV_ACCESS_KEY) throw new HttpError(503, 'ARKIV_UNCONFIGURED', 'Configure the Arkiv access key to publish and discover networking intents.');
  return createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY });
}
let provider: ReturnType<typeof createProviderFromEnv> | undefined;
export function inferenceProvider() {
  provider ??= createProviderFromEnv(process.env);
  return provider;
}
export function ai() {
  return new MeetiAgentService(inferenceProvider(), async request => {
    const value = await authority(request.actorId, request.action);
    if (value.policy.purpose !== request.purpose) throw new HttpError(403, 'PURPOSE_DENIED', 'This agent policy does not cover the introduction purpose.');
    const ownerProfile = profile(request.actorId);
    if (!ownerProfile.aiConsent) throw new HttpError(403, 'AI_CONSENT_REQUIRED', 'The owner has not permitted AI evaluation.');
    return { allowed: true, reason: 'Current ENS authority and purpose-specific disclosure policy verified.',
      policyVersion: value.policy.version, checkedAt: new Date().toISOString(), expiresAt: value.policy.expiresAt,
      allowedFieldIds: request.fieldIds.filter(id => qualificationAnswerAllowed(request.actorId, request.subjectId, id, value.policy)
        || contextFieldAllowed(request.actorId, id, ownerProfile, value.policy)
        || (value.policy.allowedFields.includes(id) && ownerProfile.publicFields.includes(id) && !['contact', 'employer', 'documentContext', 'socialLinks'].includes(id))) };
  });
}
export function participant(userId: string, intent: Intent): AgentParticipant {
  const value = agent(userId);
  if (!value) throw new HttpError(409, 'AGENT_REQUIRED', 'An agent is unavailable.');
  const p = profile(userId);
  return { userId, agentId: value.id,
    intent: { id: intent.id, version: intent.version, goal: intent.goal, summary: intent.summary, tags: intent.tags, expiresAt: intent.expiresAt, ...(intent.semantics ? { direction: intent.semantics.direction } : {}) },
    fields: [...['headline', 'bio', 'offering', 'seeking'].filter(id => p.publicFields.includes(id) && value.policy.allowedFields.includes(id))
      .flatMap(id => { const field = p[id as keyof typeof p]; return typeof field === 'string' && field.trim() ? [{ id, label: id, value: field, visibility: 'public' as const }] : []; }),
      ...approvedContextFields(userId, p).filter(field => contextFieldAllowed(userId, field.id, p, value.policy))] };
}
