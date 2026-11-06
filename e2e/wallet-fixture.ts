import { expect, type BrowserContext, type Page } from '@playwright/test';
import { hexToString, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Generated test EOAs sign only in the test process. The browser receives no private key.
export async function installTestMetaMask(context: BrowserContext, options: { wrongSigner?: boolean; rejectSignature?: boolean; eligible?: boolean } = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const signer = options.wrongSigner ? privateKeyToAccount(generatePrivateKey()) : owner;
  const calls: string[] = [];
  await context.exposeBinding('meetiTestWalletRequest', async (_source, request: { method: string; params?: unknown[] }) => {
    calls.push(request.method);
    if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [owner.address];
    if (request.method === 'eth_chainId') return '0xaa36a7';
    if (request.method === 'personal_sign') {
      if (options.rejectSignature) throw new Error('The test owner declined this signature.');
      const [raw, address] = request.params || [];
      expect(String(address).toLowerCase()).toBe(owner.address.toLowerCase());
      expect(typeof raw).toBe('string');
      const message = String(raw).startsWith('0x') ? hexToString(raw as Hex) : String(raw);
      expect(message).toContain('wants you to sign in with your Ethereum account:');
      expect(message).toContain('This signature does not authorize transactions or public disclosure.');
      return signer.signMessage({ message });
    }
    throw new Error(`Unauthorized test wallet method: ${request.method}`);
  });
  await context.addInitScript(({ eligible }) => {
    const provider = {
      isMetaMask: eligible,
      request: (request: { method: string; params?: unknown[] }) => (window as unknown as {
        meetiTestWalletRequest: (value: typeof request) => Promise<unknown>;
      }).meetiTestWalletRequest(request),
    };
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'meeti-generated-eoa-test', name: 'MetaMask test provider', rdns: eligible ? 'io.metamask' : 'test.otherwallet' }, provider },
    })));
  }, { eligible: options.eligible !== false });
  return { address: owner.address, calls };
}

export async function signInWithTestWallet(page: Page) {
  await page.goto('/dashboard');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await expect(page.getByText('Your sign-in message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with MetaMask', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
}

export async function dismissTour(page: Page) {
  const tour = page.getByRole('dialog', { name: 'A quick look around', exact: true });
  await expect(tour).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect(tour).toHaveCount(0);
}
