export type InjectedWallet = { isMetaMask?: boolean; isBraveWallet?: boolean; isRabby?: boolean; providers?: InjectedWallet[]; request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export type WalletChallenge = { id: string; message: string; address: string; chainId: number; expiresAt: string };
let selected: InjectedWallet | undefined;
function isMetaMask(provider: InjectedWallet) { return provider.isMetaMask === true && !provider.isBraveWallet && !provider.isRabby; }
export async function findMetaMask(): Promise<InjectedWallet> {
  if (selected) return selected;
  const discovered = new Map<string, InjectedWallet>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { rdns?: string; uuid?: string }; provider?: InjectedWallet }>).detail;
    if (detail?.info?.rdns === 'io.metamask' && detail.provider && isMetaMask(detail.provider)) discovered.set(detail.info.uuid || 'metamask', detail.provider);
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise(resolve => window.setTimeout(resolve, 180));
  window.removeEventListener('eip6963:announceProvider', announce);
  if (discovered.size === 1) selected = [...discovered.values()][0];
  if (discovered.size > 1) throw new Error('More than one MetaMask instance is available. Enable one instance, then reconnect.');
  if (!selected) {
    const injected = (window as unknown as { ethereum?: InjectedWallet }).ethereum;
    const candidates = injected?.providers || (injected ? [injected] : []);
    const eligible = candidates.filter(isMetaMask);
    if (eligible.length === 1) selected = eligible[0];
  }
  if (!selected) throw new Error('MetaMask was not found. Install or enable MetaMask, unlock it, and retry. Other wallets are not supported for this sign-in.');
  return selected;
}
export function wallet(): InjectedWallet {
  if (selected) return selected;
  const injected = (window as unknown as { ethereum?: InjectedWallet }).ethereum;
  const eligible = (injected?.providers || (injected ? [injected] : [])).filter(isMetaMask);
  if (eligible.length === 1) { selected = eligible[0]; return selected; }
  throw new Error('Connect MetaMask before continuing.');
}
