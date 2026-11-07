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

/** Preserve the server-quoted fee fields. This check does not submit or sign anything. */
export function boundedEnsWalletRequest(raw: Record<string, unknown>, maxFeeWei: string, expiresAt: string, now = Date.now()) {
  if (!/^[1-9][0-9]{0,14}$/.test(maxFeeWei) || BigInt(maxFeeWei) > 500000000000000n
    || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) throw new Error('Review a fresh ENS transaction with an explicit fee limit before wallet approval.');
  if (Number(raw.chainId) !== 11155111 || typeof raw.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.from)
    || typeof raw.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.to) || typeof raw.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw.data)
    || raw.value !== '0x0' || typeof raw.gas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw.gas)
    || typeof raw.maxFeePerGas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw.maxFeePerGas)
    || typeof raw.maxPriorityFeePerGas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw.maxPriorityFeePerGas)
    || raw.gasPrice !== undefined || raw.type !== '0x2') throw new Error('The ENS wallet request is missing its exact Sepolia fee quote.');
  const gas = BigInt(raw.gas), gasPrice = BigInt(raw.maxFeePerGas), priority = BigInt(raw.maxPriorityFeePerGas);
  if (gas <= 0n || gasPrice <= 0n || gasPrice > 500000000n || priority < 0n || priority > 10000000n || priority > gasPrice || gas * gasPrice > BigInt(maxFeeWei)) throw new Error('The ENS wallet request exceeds its reviewed maximum fee.');
  return raw;
}
