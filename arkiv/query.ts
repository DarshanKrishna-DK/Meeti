import { createArkivAdapter } from '../packages/arkiv/src/index';

async function main() {
  const accessKey = process.env.ARKIV_ACCESS_KEY;
  if (!accessKey) {
    console.error('Set ARKIV_ACCESS_KEY in your local server environment. No synthetic discovery is available.');
    process.exitCode = 1;
    return;
  }
  const goal = process.argv[2] ?? 'collaborator';
  if (!['cofounder', 'collaborator', 'mentor', 'teammate'].includes(goal)) {
    console.error('Choose cofounder, collaborator, mentor, or teammate.');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await createArkivAdapter({ accessKey }).discover({
      goal: goal as 'cofounder' | 'collaborator' | 'mentor' | 'teammate',
      tags: process.argv.slice(3), includeDemo: process.env.ARKIV_INCLUDE_DEMO === '1', limit: 20,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error('Live Arkiv discovery failed. Check local configuration and network availability.');
    process.exitCode = 1;
  }
}

void main();
