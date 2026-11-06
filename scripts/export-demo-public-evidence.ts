import { readFileSync, writeFileSync } from 'node:fs';
import { decrypt } from '../packages/server/crypto';
import type { Candidate } from '../packages/shared/src';

// Export approved public discovery evidence only, never the surrounding session or signing journal.
type Discovery = { candidates: Candidate[]; source: string; mode: string; embeddingExecution: string; coverage: unknown; observedBlocks: string[] };
const progress = decrypt<{ discovery: Record<string, Discovery> }>(readFileSync('.local-data/demo-core-flow.enc', 'utf8'), 'meeti-demo-core-flow-v1');
const reviewSha256 = '3c3929ea2811ceb4d74faa22accfae51837d8c0446b9db687767ae95baec4506';
const journal = decrypt<{ entry: { state: string; hash: string; entityKey: string; receipt: { blockNumber: string; blockHash: string; actualFeeWei: string } } }>(
  readFileSync('.local-data/demo-intent-revision-journal.enc', 'utf8'), `meeti-demo-intent-revision-journal-v1:${reviewSha256}`);
const entry = journal.entry;
if (entry.state !== 'confirmed') throw new Error('Confirmed publication evidence is required.');
const discovery = ['demo-seeker', 'demo-recruiter'].map(label => {
  const value = progress.discovery[`collaboration:${label}`];
  if (!value || value.source !== 'arkiv' || value.mode !== 'semantic') throw new Error('Actual semantic discovery evidence is required.');
  return { label, source: value.source, mode: value.mode, embeddingExecution: value.embeddingExecution,
    coverage: value.coverage, observedBlocks: value.observedBlocks,
    candidates: value.candidates.map(candidate => ({ key: candidate.key, intentId: candidate.intentId, version: candidate.version,
      ensAgentRef: candidate.ensAgentRef, owner: candidate.owner, match: candidate.match })) };
});
writeFileSync('artifacts/demo-workshop-revision-live.json', JSON.stringify({ exportedAt: new Date().toISOString(), fictional: true,
  humanVerified: false, reviewSha256, publication: { state: entry.state, hash: entry.hash, entityKey: entry.entityKey, receipt: entry.receipt }, discovery }, null, 2));
console.log('Public receipt and discovery evidence exported without sessions or signing data.');
