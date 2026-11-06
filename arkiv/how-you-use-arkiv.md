# How the application uses Arkiv

Meeti: Good connections begin with a little intent.

Arkiv is the authoritative shared index of active, explicitly public networking intents. The Discover UI must call the server adapter. The server uses its private `ARKIV_ACCESS_KEY` to query Rabdi. There is no database, fixture, or seeded fallback for public discovery.

Publishing starts with a reviewed public preview. The owner signs `intentSigningMessage(intent)` with the connected wallet. The server verifies that exact projection, current ENS authority, and session ownership before preparing a transaction. The Arkiv adapter uses the documented SDK through an unsigned transport that refuses every RPC method except an explicit read allowlist and gas estimation. The estimate captures the native transaction calldata and stops the SDK before any send. No signing key enters the adapter.

Preparation verifies Rabdi, estimates at `latest`, sets gas to `max(1,000,000, 2 × estimate)`, enforces half the latest block gas limit, reads current gas price and nonce, rejects pending nonce differences, and checks fee budget and balance. The returned EIP-1193 request contains only public transaction fields. It expires after at most 60 seconds. The connected wallet must review and confirm it separately. The adapter never broadcasts, creates accounts, funds wallets, switches signers, or retries a write.

After a user submits, the backend verifies a successful receipt, native transaction destination, exact entity creation event, creation block, live entity, signed payload, protected owner and creator, and preview digest. A missing or uncertain result remains unverified. Reconcile the existing hash before any further signature.

Discovery uses schema `meeti.public_intent.v2` and indexed complementary direction, category, optional topic slots, public visibility, opt-in, demo provenance and application expiration. The adapter supports up to five pages of 100 entities by ascending key. The backend interleaves topic and broad category queries, beginning with the broad scan, and assesses at most twelve candidates with explicit bounded-coverage reporting. All pages are observations of current state, not an atomic historical snapshot. The response reports observed blocks, truncation, and rejected entity count. Invalid filters and provider failures are errors. A successful empty query is an honest empty result.

Candidates are verified before blocked-owner, self, topic, and demo filters are rechecked locally. The highest observed version of each owner and intent is retained; conflicting payloads at the same version fail closed. Before returning a candidate, another current query reads the highest chain-present version for that owner and intent without goal, topic, demo, or application-time filters. A newer changed or expired version suppresses the older candidate. Deleted or chain-expired versions cannot be recovered from current-state queries, so the application must retain its own version high-water mark. A protected action must revalidate the selected entity, current version, and ENS policy and must not infer freshness from a cached candidate.

Run a real public query after configuring a local server key:

```powershell
node --env-file-if-exists=.env.local --import tsx arkiv/query.ts collaborator typescript
```

Set `ARKIV_INCLUDE_DEMO=1` locally only when intentionally querying labeled fictional public profiles. Output contains real returned public entities and observation metadata. It does not claim any external publication has occurred.

Focused tests:

```powershell
npx vitest run packages/arkiv/src/index.test.ts
```

Official tooling was read through the available Arkiv General MCP and the [AI Tools Hub](https://hub.arkiv.network/ai-tools). The [agent skill page](https://docs.arkiv.network/start-here/agent-skill/) links a deprecated best-practices entrypoint; the canonical MCP router currently points to `skills/arkiv/skill` and SDK 1.0.1. The official SDK source and MCP errata were consulted before implementation. Retrieval is separate from project MCP installation and application proof.
