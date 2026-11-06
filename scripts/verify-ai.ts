import { mkdirSync, writeFileSync } from 'node:fs';
import { createProviderFromEnv, MeetiAgentService } from '../packages/agents/src';
async function main() {
  const provider = createProviderFromEnv(process.env);
  const service = new MeetiAgentService(provider, async () => { throw new Error('This structure-only check does not authorize protected networking.'); });
  try {
    const result = await service.structureIntent({ text: 'This is a fictional development test. I offer TypeScript development and accessible web engineering. I am looking for a collaborator to build community tools. Relevant topics are community and accessibility.', providerDisclosureConsent: true });
    const evidence = { observedAt: new Date().toISOString(), inputProvenance: 'fictional development test; actual provider inference',
      inference: result.inference, suggestedGoal: result.output.goal, tags: result.output.tags };
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/live-ai.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } catch {
    console.error('The actual Meeti AI adapter did not complete. No model output or success was substituted.');
    process.exitCode = 1;
  }
}
void main();
