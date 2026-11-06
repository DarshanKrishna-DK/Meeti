import { mkdirSync, writeFileSync } from 'node:fs';
import { createArkivAdapter } from '../packages/arkiv/src';
import { createEnsAuthorityProvider } from '../packages/ens';
import { createProviderFromEnv, MeetiAgentService, type AgentParticipant } from '../packages/agents/src';

// These are previously approved fictional test publications. This command never signs or publishes.
const keys = ['0x29ece6b4ae9156b0b1c87e4e309244f1378a10a393ed40886ced2b56ebc9c654', '0xd6301bc2a960aa99c5e1d9d829add9c2fde20b7ec280f7ae7c2a6d78f64de942'] as const;
const digest = '0x07f3791f3c41b351590bce2c690157f454f7162c47961b0ed510d947540d6f3b';
const adapter = createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY! });
const namespaces = [
  { ensName: 'agent.meeti-demo.eth', owner: '0x9253705482a44e6A7378163e57cc791AE6213ed5', delegate: '0xEE291Bc0246441F53610FbCAF2bC892110e72732', resolverAddress: '0xBc686bC5080ECBabcc3Bef38aA985865462D0433', policyDigest: digest },
  { ensName: 'agent.crypteck.eth', owner: '0xEE291Bc0246441F53610FbCAF2bC892110e72732', delegate: '0x9253705482a44e6A7378163e57cc791AE6213ed5', resolverAddress: '0xBB6DD000864d10d98adb5B26E098A20Da717208E', policyDigest: digest },
];
const readers = namespaces.map(namespace => createEnsAuthorityProvider({ rpcUrl: process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL!, namespace }));
const evidence: unknown[] = [];
try {
  const records = await Promise.all(keys.map(key => adapter.readActive(key)));
  const participants: AgentParticipant[] = records.map(record => ({ userId: record.owner.toLowerCase(), agentId: record.intent.ensAgentRef,
    intent: { id: record.intent.intentId, version: record.intent.version, goal: record.intent.goal, direction: record.intent.semantics.direction,
      summary: record.intent.summary, tags: record.intent.tags, expiresAt: record.intent.expiresAt }, fields: [] }));
  const provider = createProviderFromEnv({ ...process.env, AI_MAX_REQUESTS: '2', AI_MAX_COST_USD: '0.05' });
  const service = new MeetiAgentService(provider, async request => {
    const index = namespaces.findIndex(namespace => namespace.owner.toLowerCase() === request.actorId);
    if (index < 0) throw new Error('Unknown test publication owner.');
    const namespace = namespaces[index];
    const checked = await readers[index].checkAuthority({ ...namespace, action: request.action, policyVersion: '1' });
    evidence.push({ name: namespace.ensName, allowed: checked.allowed, reason: checked.reason, checkedAt: new Date().toISOString() });
    if (!checked.allowed) throw new Error('Current ENS authority denied the live qualification check.');
    return { allowed: true, reason: 'Live Sepolia ENS authority for the approved fictional Arkiv publication.', policyVersion: 1,
      allowedFieldIds: [], checkedAt: new Date().toISOString(), expiresAt: new Date(Math.min(...records.map(record => Date.parse(record.intent.expiresAt)))).toISOString() };
  });
  const result = await service.qualifyIntroduction({ left: participants[0], right: participants[1], purpose: 'collaborator', maxRounds: 1,
    onProgress: event => { if (event.kind === 'turn_completed') evidence.push({ kind: event.kind, inference: event.message.inference }); } });
  const report = { checkedAt: new Date().toISOString(), scope: 'Live Arkiv read, current ENS authorization, and actual model qualification. Not application inbox or independent-human E2E.',
    keys, state: result.state, stopReason: result.stopReason, messages: result.messages.length, questions: result.ownerQuestions.length,
    receipts: result.messages.map(message => message.inference), authority: evidence };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/qualification-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  let diagnostic = error instanceof Error ? error.message : 'Unknown failure';
  for (const secret of [process.env.ARKIV_ACCESS_KEY, process.env.AI_API_KEY]) if (secret) diagnostic = diagnostic.replaceAll(secret, '[REDACTED]');
  diagnostic = diagnostic.replace(/https?:\/\/[^\s)]+/g, '[REDACTED_ENDPOINT]').slice(0, 400);
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/qualification-live-failure.json', JSON.stringify({ checkedAt: new Date().toISOString(), code: error instanceof Error ? error.name : 'unknown', diagnostic, evidence }, null, 2));
  console.error(diagnostic);
  console.error('Live qualification did not pass. No result or authorization was fabricated.'); process.exitCode = 1;
} finally { for (const reader of readers) reader.disconnect(); }
