import type { IntentSemantics } from '../../matching/src/semantics';
import type { RankedCandidate } from '../../matching/src/ranking';
export type Goal = 'cofounder' | 'collaborator' | 'mentor' | 'teammate';
export type Action = 'discover' | 'publish' | 'evaluate' | 'negotiate' | 'introduce' | 'message';
export type Profile = {
  displayName: string; headline: string; bio: string; seeking: string; offering: string;
  tags: string[]; contact: string; employer: string; publicFields: string[]; aiConsent: boolean;
  socialLinks?: { label: string; url: string }[];
  roles?: string[]; skills?: string[]; interests?: string[]; goals?: string[];
  location?: string; timezone?: string; languages?: string[]; availability?: string;
  collaborationMode?: 'unspecified' | 'remote' | 'hybrid' | 'in-person';
  contextSharing?: 'private-agent' | 'authorized-counterpart' | 'ask-first';
};
export type ContextDocument = { id: string; name: string; mimeType: 'application/pdf' | 'text/plain' | 'text/markdown'; size: number;
  title?: string; description?: string; sharingScope?: 'private-agent' | 'authorized-counterpart' | 'ask-first' | 'public'; publicExcerptApproved?: boolean;
  version: number; extractedText: string; extractionStatus: 'ready' | 'no-text' | 'failed';
  reviewedExcerpt: string; allowAgentContext: boolean; allowOriginalShare: boolean; createdAt: string; updatedAt: string };
export type Policy = { version: number; purpose: Goal; allowedFields: string[]; allowedActions: Action[]; expiresAt: string; paused: boolean };
export type Agent = {
  id: string; ensName: string; owner: string; delegate: string; persona: string;
  policy: Policy; authority: { allowed: boolean; reason: string; checkedAt: string; evidence?: unknown } | null;
  config: Record<string, unknown>;
};
export type Intent = {
  id: string; version: number; goal: Goal; summary: string; tags: string[]; expiresAt: string;
  createdAt: string; policyVersion: number; status: 'draft' | 'published' | 'expired' | 'revoked';
  arkivKey?: string; transactionHash?: string; demoOrigin: boolean;
  semantics?: IntentSemantics; publicStatus?: 'active' | 'closed';
};
export type Consent = { userId: string; decision: 'approve' | 'decline' | 'revoke'; createdAt: string; digest: string };
export type Proposal = {
  id: string; status: 'proposed' | 'waiting_consents' | 'declined' | 'revoked' | 'expired' | 'blocked' | 'introduced';
  candidateName: string; candidateEns: string; summary: string; compatibility: unknown; digest: string;
  messages: { speaker: string; content: string; allowed: boolean; reason?: string }[];
  consents: Consent[]; myConsent: string | null; world: { verified: boolean; reason: string };
  createdAt: string; roomId?: string;
};
export type Room = { id: string; proposalId: string; title: string; introduction: string; createdAt: string };
export type Audit = { id: string; action: string; outcome: string; detail: string; createdAt: string };
export type AgentRun = { id: string; kind: 'proposal'; status: 'running' | 'completed' | 'failed' | 'interrupted';
  stage: 'checking_permissions' | 'evaluating_fit' | 'exchanging_context' | 'rechecking_permissions' | 'completed' | 'failed' | 'interrupted';
  startedAt: string; updatedAt: string; expiresAt: string; proposalId?: string };
export type IntegrationStatus = { configured: boolean; status: 'ready' | 'unconfigured' | 'blocked' | 'deferred'; message: string };
export type OnboardingState = { profileComplete: boolean; tourCompleted: boolean; hasAgent: boolean; hasIntent: boolean; hasPublishedIntent: boolean };
export type AppState = {
  user: { id: string; email: string; wallet: string | null }; profile: Profile; agent: Agent | null;
  intents: Intent[]; proposals: Proposal[]; rooms: Room[]; audit: Audit[]; agentRuns?: AgentRun[];
  agentTasks?: { taskId: string; kind: 'propose' | 'resume' | 'retry'; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'expired'; updatedAt: string; error?: { code: string; message: string } }[];
  integrations: Record<'ens' | 'arkiv' | 'ai' | 'world', IntegrationStatus>;
};
export type Candidate = { key: string; intentId: string; ensAgentRef: string; goal: Goal; summary: string; tags: string[]; expiresAt: string; owner: string; version: number; policyVersion: number; demoOrigin: boolean; match?: RankedCandidate };
export type ApiResult<T> = { data: T } | { error: { code: string; message: string } };
