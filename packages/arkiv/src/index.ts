import { createPublicClient, createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime, randomSalt } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { addr, bool, bytes, defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema';
import { and, asc, desc, eq, gt, or } from '@arkiv-network/sdk/query';
import { custom, decodeEventLog, getAddress, hexToBytes, http, keccak256, numberToHex, stringToHex, verifyMessage, type Address, type Hex } from 'viem';
import { getGasPrice } from 'viem/actions';
import { z } from 'zod';
import { IntentSemanticsSchema, canonicalRoleLabel, type Direction } from '../../matching/src/semantics';

export const ARKIV_CHAIN_ID = 7794095;
export const ARKIV_NATIVE_ADDRESS = '0x4400000000000000000000000000000000000044' as const;
export const ARKIV_SCHEMA_NAME = 'meeti.public_intent.v2';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const iso = z.string().datetime({ offset: true });

export const PublicIntentSchema = z.object({
  intentId: z.string().min(1).max(80).refine(value => encoder.encode(value).length <= 128),
  ensAgentRef: z.string().min(1).max(128).refine(value => encoder.encode(value).length <= 128),
  goal: z.enum(['cofounder', 'collaborator', 'mentor', 'teammate']),
  tags: z.array(tag).min(1).max(8).refine(value => new Set(value).size === value.length),
  summary: z.string().min(1).max(1000),
  visibility: z.literal('public'),
  optIn: z.boolean(),
  schemaVersion: z.literal(2),
  status: z.enum(['active', 'closed']),
  semantics: IntentSemanticsSchema,
  owner: address,
  version: z.number().int().positive().max(2147483647),
  policyVersion: z.number().int().positive().max(2147483647),
  createdAt: iso,
  expiresAt: iso,
  demoOrigin: z.boolean(),
}).strict().refine(value => value.optIn === (value.status === 'active'), 'Only active intents opt in')
  .refine(value => value.semantics.category === value.goal, 'Intent category must match its policy purpose')
  .refine(value => value.semantics.direction !== 'unknown' && value.semantics.clarificationQuestions.length === 0, 'Clarify the intent before publication')
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt), 'Expiration must follow creation')
  .refine(value => Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= MAX_AGE_MS, 'Intent lifetime is at most 30 days');

export type PublicIntent = z.infer<typeof PublicIntentSchema>;
export type DiscoveredIntent = {
  intent: PublicIntent;
  entityKey: Hex;
  owner: Address;
  creator: Address;
  chainExpiresAtBlock: string;
  observedAtBlock: string;
  source: 'arkiv';
};
export type DiscoveryFilter = {
  goal?: PublicIntent['goal'];
  tags?: string[];
  excludeOwner?: string;
  blockedOwners?: string[];
  includeDemo?: boolean;
  limit?: number;
  directions?: Direction[];
};
export type PreparedArkivTransaction = {
  chainId: typeof ARKIV_CHAIN_ID;
  account: Address;
  request: { from: Address; to: typeof ARKIV_NATIVE_ADDRESS; data: Hex; value: '0x0'; chainId: Hex; gas: Hex; gasPrice: Hex; nonce: Hex; type: '0x0' };
  maximumFeeWei: string;
  preparedAt: string;
  expiresAt: string;
  intent: PublicIntent;
  payloadDigest: Hex;
};

export const PublicIntents = defineSchema(ARKIV_SCHEMA_NAME, {
  intentId: str().indexed(), ensAgentRef: str(), goal: str().indexed(),
  visibility: str().indexed(), optIn: bool().indexed(), owner: addr().indexed(),
  version: u64().indexed(), policyVersion: u64(), createdAt: u64(), expiresAt: u64().indexed(),
  demoOrigin: bool().indexed(),
  schemaVersion: u64().indexed(), status: str().indexed(), direction: str().indexed(), category: str().indexed(),
  canonicalRole: str().indexed(),
  tag0: str().indexed(), tag1: str().indexed(), tag2: str().indexed(), tag3: str().indexed(),
  tag4: str().indexed(), tag5: str().indexed(), tag6: str().indexed(), tag7: str().indexed(),
  envelope: bytes(),
});

export function canonicalIntent(input: unknown): PublicIntent {
  const value = PublicIntentSchema.parse(input);
  return {
    intentId: value.intentId, ensAgentRef: value.ensAgentRef, goal: value.goal,
    tags: [...value.tags].sort(), summary: value.summary, visibility: 'public', optIn: value.optIn,
    schemaVersion: 2, status: value.status, semantics: value.semantics,
    owner: getAddress(value.owner), version: value.version, policyVersion: value.policyVersion,
    createdAt: new Date(value.createdAt).toISOString(), expiresAt: new Date(value.expiresAt).toISOString(),
    demoOrigin: value.demoOrigin,
  };
}

export function intentSigningMessage(input: unknown): string {
  return `Meeti public intent v2\nchainId=${ARKIV_CHAIN_ID}\nschema=${ARKIV_SCHEMA_NAME}\n${JSON.stringify(canonicalIntent(input))}`;
}

export function intentDigest(input: unknown): Hex {
  return keccak256(stringToHex(intentSigningMessage(input)));
}

function safeFailure(message: string): Error { return new Error(message); }
function liveIntent(intent: PublicIntent, now: number): boolean {
  return intent.status === 'active' && intent.optIn && Date.parse(intent.createdAt) <= now + 60_000 && Date.parse(intent.expiresAt) > now;
}
function exactRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safeFailure('Invalid Arkiv entity');
  return value as Record<string, unknown>;
}
function typedValue(row: Record<string, unknown>, field: string, type: string): unknown {
  const column = exactRecord(row[field]);
  if (column.type !== type) throw safeFailure('Invalid Arkiv entity column');
  return column.value;
}
function big(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw safeFailure('Invalid Arkiv block value');
  return value;
}
function sameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && address.safeParse(a).success && a.toLowerCase() === b.toLowerCase();
}

/** Validate every entity again after SDK decoding, before it can enter matching. */
async function decodeDiscoveredEntity(raw: unknown, observedBlock: bigint, now: number, requireActive: boolean): Promise<DiscoveredIntent> {
  const row = exactRecord(raw);
  const entityKey = hex32.parse(row.$key) as Hex;
  const chainExpiry = big(row.$expiresAt);
  if (chainExpiry <= observedBlock) throw safeFailure('Arkiv intent has expired');
  const flags = exactRecord(row.$creationFlags);
  if (flags.readonly !== true || flags.permissionlessExtension !== false) throw safeFailure('Arkiv publication flags are invalid');
  const encoded = typedValue(row, 'envelope', 'bytes');
  if (typeof encoded !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(encoded) || encoded.length > 32_770) throw safeFailure('Invalid public intent envelope');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(encoded as Hex))); }
  catch { throw safeFailure('Invalid public intent envelope'); }
  const envelope = z.object({ intent: PublicIntentSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict().parse(decoded);
  const intent = canonicalIntent(envelope.intent);
  if (Date.parse(intent.createdAt) > now + 60_000 || (requireActive && !liveIntent(intent, now))) throw safeFailure('Public intent has expired or is not yet active');
  if (!sameAddress(row.$owner, intent.owner) || !sameAddress(row.$creator, intent.owner)) throw safeFailure('Public intent owner does not match its publisher');
  if (!await verifyMessage({ address: intent.owner as Address, message: intentSigningMessage(intent), signature: envelope.signature as Hex })) throw safeFailure('Public intent signature is invalid');
  const expected: Record<string, unknown> = {
    intentId: intent.intentId, ensAgentRef: intent.ensAgentRef, goal: intent.goal,
    visibility: 'public', optIn: intent.optIn, version: BigInt(intent.version), policyVersion: BigInt(intent.policyVersion),
    schemaVersion: 2n, status: intent.status, direction: intent.semantics.direction, category: intent.semantics.category,
    canonicalRole: canonicalRoleLabel(intent.semantics.canonicalRole?.value || '').slice(0, 32),
    createdAt: BigInt(Date.parse(intent.createdAt)), expiresAt: BigInt(Date.parse(intent.expiresAt)), demoOrigin: intent.demoOrigin,
  };
  for (const [field, value] of Object.entries(expected)) {
    const type = typeof value === 'bigint' ? 'u64' : typeof value === 'boolean' ? 'bool' : 'str';
    if (typedValue(row, field, type) !== value) throw safeFailure('Public intent does not match its indexed fields');
  }
  if (!sameAddress(typedValue(row, 'owner', 'addr'), intent.owner)) throw safeFailure('Public intent owner index is invalid');
  for (let index = 0; index < 8; index++) {
    if (typedValue(row, `tag${index}`, 'str') !== (intent.tags[index] ?? '')) throw safeFailure('Public intent tags do not match their indexes');
  }
  return { intent, entityKey, owner: getAddress(intent.owner), creator: getAddress(intent.owner),
    chainExpiresAtBlock: chainExpiry.toString(), observedAtBlock: observedBlock.toString(), source: 'arkiv' };
}

export async function validateDiscoveredEntity(raw: unknown, observedBlock: bigint, now = Date.now()): Promise<DiscoveredIntent> {
  return decodeDiscoveredEntity(raw, observedBlock, now, true);
}

export function createArkivAdapter(config: { accessKey: string; now?: () => number; maxPages?: number }) {
  if (typeof config.accessKey !== 'string' || !config.accessKey.trim()) throw safeFailure('Arkiv access key is not configured');
  const chain = rabdi({ accessKey: config.accessKey });
  const transport = http(undefined, { retryCount: 0, timeout: 10_000, fetchOptions: { cache: 'no-store', redirect: 'error' } });
  const client = createPublicClient({ chain, cacheTime: 0, transport });
  const now = config.now ?? Date.now;
  const maxPages = config.maxPages ?? 5;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw safeFailure('Invalid discovery page budget');

  async function discover(filter: DiscoveryFilter = {}) {
    const parsed = z.object({ goal: z.enum(['cofounder', 'collaborator', 'mentor', 'teammate']).optional(),
      tags: z.array(tag).max(8).optional(), excludeOwner: address.optional(), blockedOwners: z.array(address).max(200).optional(),
      includeDemo: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), directions: z.array(IntentSemanticsSchema.shape.direction).min(1).max(9).optional() }).strict().parse(filter);
    try {
      if (await client.getChainId() !== ARKIV_CHAIN_ID) throw safeFailure('Unexpected Arkiv network');
      const blocked = new Set([...(parsed.blockedOwners ?? []), ...(parsed.excludeOwner ? [parsed.excludeOwner] : [])].map(value => value.toLowerCase()));
      const observedBlocks: string[] = [];
      const candidates = new Map<string, DiscoveredIntent>();
      let last: Hex | undefined;
      let truncated = false;
      let rejectedEntities = 0;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const query = client.select().from(PublicIntents, { onMismatch: 'throw' })
          .where(and(eq('visibility', 'public'), eq('optIn', true), eq('status', 'active'), eq('schemaVersion', u64(2)), gt('expiresAt', u64(now()))))
          .orderBy(asc('$key')).limit(100);
        if (parsed.goal) query.where(eq('goal', parsed.goal));
        if (parsed.directions) query.where(or(...parsed.directions.map(value => eq('direction', value))));
        if (parsed.includeDemo !== true) query.where(eq('demoOrigin', false));
        if (parsed.tags?.length) query.where(or(...parsed.tags.flatMap(value => [
          eq('tag0', value), eq('tag1', value), eq('tag2', value), eq('tag3', value),
          eq('tag4', value), eq('tag5', value), eq('tag6', value), eq('tag7', value),
        ])));
        if (last) query.where(gt('$key', key(last)));
        const page = await query.fetch();
        const observed = big(page.blockNumber);
        observedBlocks.push(observed.toString());
        if (page.entities.length > 100 || page.skipped !== 0) throw safeFailure('Invalid Arkiv page');
        for (const row of page.entities) {
          let candidate: DiscoveredIntent;
          try { candidate = await validateDiscoveredEntity(row, observed, now()); }
          catch { rejectedEntities++; continue; }
          if (blocked.has(candidate.owner.toLowerCase()) || (parsed.goal && candidate.intent.goal !== parsed.goal)
            || (parsed.directions && !parsed.directions.includes(candidate.intent.semantics.direction))
            || (parsed.includeDemo !== true && candidate.intent.demoOrigin)
            || (parsed.tags?.length && !parsed.tags.some(value => candidate.intent.tags.includes(value)))) continue;
          const identity = `${candidate.owner.toLowerCase()}:${candidate.intent.intentId}`;
          const prior = candidates.get(identity);
          if (!prior || candidate.intent.version > prior.intent.version) candidates.set(identity, candidate);
          else if (candidate.intent.version === prior.intent.version && intentDigest(candidate.intent) !== intentDigest(prior.intent)) {
            throw safeFailure('Conflicting versions of a public intent');
          }
        }
        if (page.entities.length < 100) break;
        const next = page.entities.at(-1)?.$key;
        if (!next || (last && next.toLowerCase() <= last.toLowerCase())) throw safeFailure('Arkiv pagination did not advance');
        last = next;
        if (pageIndex === maxPages - 1) truncated = true;
      }
      const finalNow = now();
      const list = [...candidates.values()].filter(value => liveIntent(value.intent, finalNow))
        .sort((a, b) => b.intent.version - a.intent.version || a.entityKey.localeCompare(b.entityKey));
      const checked: DiscoveredIntent[] = [];
      // Query the newest publication without goal, tag, demo, or app-time filters.
      // A changed or expired newer intent must suppress an older matching revision.
      for (const candidate of list.slice(0, parsed.limit ?? 20)) {
        const latest = await client.select().from(PublicIntents, { onMismatch: 'throw' })
          .ownedBy(candidate.owner).createdBy(candidate.owner).where(eq('intentId', candidate.intent.intentId))
          .orderBy(desc('version')).limit(1).fetch();
        const block = big(latest.blockNumber);
        observedBlocks.push(block.toString());
        if (latest.entities.length !== 1 || latest.skipped !== 0) continue;
        let newest: DiscoveredIntent;
        try { newest = await decodeDiscoveredEntity(latest.entities[0], block, now(), false); }
        catch { rejectedEntities++; continue; }
        if (newest.intent.version > candidate.intent.version) continue;
        if (newest.intent.version !== candidate.intent.version || intentDigest(newest.intent) !== intentDigest(candidate.intent)) {
          throw safeFailure('Public intent version changed during discovery');
        }
        if (liveIntent(candidate.intent, now())) checked.push(candidate);
      }
      return { candidates: checked, observedBlocks, source: 'arkiv' as const,
        truncated: truncated || list.length > (parsed.limit ?? 20), rejectedEntities };
    } catch { throw safeFailure('Arkiv discovery is unavailable. New public discovery is blocked.'); }
  }

  async function preparePublish(input: { intent: unknown; signature: Hex; maxFeeWei: string }): Promise<PreparedArkivTransaction> {
    const intent = canonicalIntent(input.intent);
    if (Date.parse(intent.expiresAt) <= now()) throw safeFailure('Only unexpired public records can be published');
    if (!/^\d+$/.test(input.maxFeeWei) || BigInt(input.maxFeeWei) <= 0n) throw safeFailure('A positive maximum fee is required');
    if (!await verifyMessage({ address: intent.owner as Address, message: intentSigningMessage(intent), signature: input.signature })) throw safeFailure('The owner must sign the exact public intent preview');
    try {
      if (await client.getChainId() !== ARKIV_CHAIN_ID) throw safeFailure('Unexpected Arkiv network');
      const envelope = encoder.encode(JSON.stringify({ intent, signature: input.signature }));
      const values = { intentId: intent.intentId, ensAgentRef: intent.ensAgentRef, goal: intent.goal,
        visibility: 'public', optIn: intent.optIn, owner: addr(intent.owner), version: u64(intent.version), policyVersion: u64(intent.policyVersion),
        schemaVersion: u64(2), status: intent.status, direction: intent.semantics.direction, category: intent.semantics.category,
        canonicalRole: canonicalRoleLabel(intent.semantics.canonicalRole?.value || '').slice(0, 32),
        createdAt: u64(Date.parse(intent.createdAt)), expiresAt: u64(Date.parse(intent.expiresAt)), demoOrigin: intent.demoOrigin,
        tag0: intent.tags[0] ?? '', tag1: intent.tags[1] ?? '', tag2: intent.tags[2] ?? '', tag3: intent.tags[3] ?? '',
        tag4: intent.tags[4] ?? '', tag5: intent.tags[5] ?? '', tag6: intent.tags[6] ?? '', tag7: intent.tags[7] ?? '', envelope };
      const rpc = transport({ chain });
      const stopped = new Error('Unsigned Arkiv request captured');
      let estimate: bigint | undefined;
      let captured: { to: Hex; data: Hex; from: Address; value?: Hex } | undefined;
      const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_maxPriorityFeePerGas']);
      const guarded = custom({ async request(args) {
        if (args.method === 'eth_estimateGas') {
          const raw = exactRecord(args.params?.[0]);
          if (!sameAddress(raw.to, ARKIV_NATIVE_ADDRESS) || !sameAddress(raw.from, intent.owner)
            || typeof raw.data !== 'string' || !/^0x[0-9a-f]+$/i.test(raw.data)
            || (raw.value !== undefined && raw.value !== '0x0')) throw safeFailure('Unexpected Arkiv transaction');
          captured = { to: raw.to as Hex, data: raw.data as Hex, from: getAddress(intent.owner) };
          const result: unknown = await rpc.request({ method: 'eth_estimateGas', params: [raw, 'latest'] });
          if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) throw safeFailure('Invalid unsigned estimate');
          estimate = BigInt(result);
          throw stopped;
        }
        if (!allowed.has(args.method)) throw safeFailure('Signing and transaction submission are blocked during preparation');
        return rpc.request(args);
      } }, { retryCount: 0 });
      const unsigned = createWalletClient({ account: getAddress(intent.owner), chain, transport: guarded });
      try {
        await unsigned.createEntity(PublicIntents, values, {
          expiration: ExpirationTime.atDate(new Date(intent.expiresAt)),
          flags: { readonly: true, permissionlessExtension: false }, salt: randomSalt(),
        });
        throw safeFailure('Unsigned preparation did not stop');
      } catch {
        if (!captured || estimate === undefined || estimate <= 0n) throw safeFailure('Unsigned preparation failed');
      }
      const block = await client.getBlock({ blockTag: 'latest' });
      const gas = estimate * 2n > 1_000_000n ? estimate * 2n : 1_000_000n;
      if (gas > block.gasLimit / 2n) throw safeFailure('Required gas exceeds half the latest block limit');
      const account = getAddress(intent.owner);
      const [nonce, pendingNonce, gasPrice, balance] = await Promise.all([
        client.getTransactionCount({ address: account, blockTag: 'latest' }),
        client.getTransactionCount({ address: account, blockTag: 'pending' }),
        getGasPrice(client), client.getBalance({ address: account, blockTag: 'latest' }),
      ]);
      if (nonce !== pendingNonce) throw safeFailure('Resolve pending wallet transactions before publishing');
      const fee = gas * gasPrice;
      if (fee > BigInt(input.maxFeeWei) || fee > balance) throw safeFailure('The prepared transaction exceeds the approved fee or wallet balance');
      return { chainId: ARKIV_CHAIN_ID, account,
        request: { from: account, to: ARKIV_NATIVE_ADDRESS, data: captured.data, value: '0x0',
          chainId: numberToHex(ARKIV_CHAIN_ID), gas: numberToHex(gas), gasPrice: numberToHex(gasPrice), nonce: numberToHex(nonce), type: '0x0' },
        maximumFeeWei: fee.toString(), preparedAt: new Date(now()).toISOString(),
        expiresAt: new Date(Math.min(now() + 60_000, Date.parse(intent.expiresAt))).toISOString(), intent, payloadDigest: intentDigest(intent) };
    } catch { throw safeFailure('Arkiv transaction preparation failed. Check the network, funding, fee limit, and pending wallet transactions.'); }
  }

  async function verifyPublished(input: { entityKey?: string; txHash: string; expectedIntent: unknown; expectedTransaction?: PreparedArkivTransaction['request'] }): Promise<DiscoveredIntent> {
    const txHash = hex32.parse(input.txHash) as Hex;
    const expected = canonicalIntent(input.expectedIntent);
    try {
      if (await client.getChainId() !== ARKIV_CHAIN_ID) throw safeFailure('Unexpected Arkiv network');
      const [receipt, tx, head] = await Promise.all([
        client.getTransactionReceipt({ hash: txHash }), client.getTransaction({ hash: txHash }),
        client.getBlockNumber({ cacheTime: 0 }),
      ]);
      if (receipt.status !== 'success' || !sameAddress(receipt.from, expected.owner)
        || !sameAddress(tx.to, ARKIV_NATIVE_ADDRESS)) throw safeFailure('Arkiv publication receipt is invalid');
      if (input.expectedTransaction && (tx.input.toLowerCase() !== input.expectedTransaction.data.toLowerCase()
        || tx.value !== 0n || tx.gas > BigInt(input.expectedTransaction.gas)
        || (tx.gasPrice ?? tx.maxFeePerGas ?? 0n) > BigInt(input.expectedTransaction.gasPrice)
        || tx.nonce !== Number(BigInt(input.expectedTransaction.nonce)))) throw safeFailure('Arkiv transaction differs from the frozen approved preparation');
      const createdKeys: Hex[] = [];
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, ARKIV_NATIVE_ADDRESS)) continue;
        try {
          const event = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics });
          if (event.eventName === 'EntityCreated') createdKeys.push(event.args.entityKey);
        } catch { /* Unrelated logs do not establish publication. */ }
      }
      const entityKey = hex32.parse(input.entityKey ?? (createdKeys.length === 1 ? createdKeys[0] : undefined)) as Hex;
      const row = await client.getEntity(entityKey, PublicIntents);
      if (head < receipt.blockNumber + 1n) throw safeFailure('Arkiv publication needs another block confirmation');
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (canonical.hash !== receipt.blockHash) throw safeFailure('Arkiv publication block is no longer canonical');
      const createdInTransaction = receipt.logs.some(log => {
        if (!sameAddress(log.address, ARKIV_NATIVE_ADDRESS)) return false;
        try {
          const event = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics });
          return event.eventName === 'EntityCreated' && event.args.entityKey.toLowerCase() === entityKey.toLowerCase();
        } catch { return false; }
      });
      if (!createdInTransaction) throw safeFailure('The transaction did not create the expected Arkiv entity');
      const candidate = await decodeDiscoveredEntity(row, head, now(), expected.status === 'active');
      if (intentDigest(candidate.intent) !== intentDigest(expected) || row.$createdAt !== receipt.blockNumber) throw safeFailure('Arkiv publication does not match the confirmed preview');
      return candidate;
    } catch { throw safeFailure('Arkiv publication is not verified. Reconcile the submitted transaction without resending it.'); }
  }

  async function prepareRenewal(input: { entityKey: string; intent: unknown; signature: Hex; maxFeeWei: string }) {
    const next = canonicalIntent(input.intent);
    const entityKey = hex32.parse(input.entityKey) as Hex;
    let prior: DiscoveredIntent;
    try { prior = await validateDiscoveredEntity(await client.getEntity(entityKey, PublicIntents), await client.getBlockNumber({ cacheTime: 0 }), now()); }
    catch { throw safeFailure('Only a verified active intent can be renewed'); }
    if (!sameAddress(prior.owner, next.owner) || prior.intent.intentId !== next.intentId
      || next.version !== prior.intent.version + 1 || Date.parse(next.expiresAt) <= Date.parse(prior.intent.expiresAt)) {
      throw safeFailure('Renewal requires the same owner and intent, next version, and a later expiration');
    }
    return preparePublish({ intent: next, signature: input.signature, maxFeeWei: input.maxFeeWei });
  }

  async function readActive(entityKey: string): Promise<DiscoveredIntent> {
    try {
      if (await client.getChainId() !== ARKIV_CHAIN_ID) throw safeFailure('Unexpected Arkiv network');
      const candidate = await validateDiscoveredEntity(await client.getEntity(hex32.parse(entityKey) as Hex, PublicIntents), await client.getBlockNumber({ cacheTime: 0 }), now());
      const latest = await client.select().from(PublicIntents, { onMismatch: 'throw' }).ownedBy(candidate.owner).createdBy(candidate.owner)
        .where(eq('intentId', candidate.intent.intentId)).orderBy(desc('version')).limit(2).fetch();
      if (!latest.entities.length || latest.skipped !== 0) throw safeFailure('Public intent is unavailable');
      for (const row of latest.entities) {
        const current = await decodeDiscoveredEntity(row, big(latest.blockNumber), now(), false);
        if (current.intent.version >= candidate.intent.version && intentDigest(current.intent) !== intentDigest(candidate.intent)) throw safeFailure('Public intent changed or closed');
      }
      if (!liveIntent(candidate.intent, now())) throw safeFailure('Public intent expired');
      return candidate;
    } catch { throw safeFailure('The current Arkiv intent is unavailable, changed, closed, or expired. Refresh discovery.'); }
  }
  return { discover, readActive, preparePublish, verifyPublished, prepareRenewal };
}
