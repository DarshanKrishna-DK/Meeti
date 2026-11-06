import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decrypt, encrypt } from '../packages/server/crypto';

// Local fictional test identities. This utility never signs or submits transactions.
const vaultPath = '.local-data/demo-wallets.enc';
const context = 'meeti-demo-wallets-v1';
type Vault = { version: 1; createdAt: string; wallets: { label: string; privateKey: `0x${string}` }[] };
if (!['init', 'inspect'].includes(process.argv[2] || '')) throw new Error('Choose init or inspect.');
if (!existsSync(vaultPath)) {
  if (process.argv[2] !== 'init') throw new Error('Initialize the local test wallets first.');
  const vault: Vault = { version: 1, createdAt: new Date().toISOString(), wallets: ['demo-seeker', 'demo-recruiter'].map(label => ({ label, privateKey: generatePrivateKey() })) };
  mkdirSync('.local-data', { recursive: true });
  writeFileSync(vaultPath, encrypt(vault, context), { flag: 'wx', mode: 0o600 });
}
const vault = decrypt<Vault>(readFileSync(vaultPath, 'utf8'), context);
if (vault.version !== 1 || vault.wallets.length !== 2) throw new Error('Unsupported demo wallet vault.');
const report = { version: 1, createdAt: vault.createdAt, fictional: true, humanVerified: false,
  custody: 'Generated local test keys encrypted with the existing application encryption key. No MetaMask keys are accessed.',
  wallets: vault.wallets.map(wallet => ({ label: wallet.label, address: privateKeyToAccount(wallet.privateKey).address })),
  transactionsSigned: 0 };
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/demo-wallets.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
