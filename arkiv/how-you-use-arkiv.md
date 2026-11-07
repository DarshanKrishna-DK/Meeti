# How the application uses Arkiv

Meeti: Good connections begin with a little intent.

Arkiv is the authoritative shared index of active, explicitly public networking intents. The Discover UI must call the server adapter. The server uses its private `ARKIV_ACCESS_KEY` to query Rabdi. There is no database, fixture, or seeded fallback for public discovery.

Publishing starts with a reviewed public preview. The owner signs `intentSigningMessage(intent)` with the connected wallet. The server verifies that exact projection, current ENS authority, and session ownership before preparing a transaction. The Arkiv adapter uses the documented SDK through an unsigned transport that refuses every RPC method except an explicit read allowlist and gas estimation. The estimate captures the native transaction calldata and stops the SDK before any send. No signing key enters the adapter.

Preparation verifies Rabdi, estimates at `latest`, sets gas to `max(1,000,000, 2 × estimate)`, enforces half the latest block gas limit, reads current gas price and nonce, rejects pending nonce differences, and checks fee budget and balance. The returned EIP-1193 request contains only public transaction fields. It expires after at most 60 seconds. The connected wallet must review and confirm it separately. The adapter never broadcasts, creates accounts, funds wallets, switches signers, or retries a write.

After a user submits, the backend verifies a successful receipt, native transaction destination, exact entity creation event, creation block, live entity, signed payload, protected owner and creator, and preview digest. A missing or uncertain result remains unverified. Reconcile the existing hash before any further signature.

Discovery uses schema `meeti.public_intent.v2` and indexed complementary direction, category, optional topic slots, public visibility, opt-in, demo provenance and application expiration. The adapter supports up to five pages of 100 entities by ascending key. The backend interleaves topic and broad category queries, beginning with the broad scan, and assesses at most twelve candidates with explicit bounded-coverage reporting. All pages are observations of current state, not an atomic historical snapshot. The response reports observed blocks, truncation, and rejected entity count. Invalid filters and provider failures are errors. A successful empty query is an honest empty result.

Candidates are verified before blocked-owner, self, topic, and demo filters are rechecked locally. The highest observed version of each owner and intent is retained; conflicting payloads at the same version fail closed. Before returning a candidate, another current query reads the two highest chain-present versions for that owner and intent without goal, topic, demo, or application-time filters. A newer changed or expired version suppresses the older candidate. Any tie at the selected version is ambiguous and rejected, even if the payloads agree. Deleted or chain-expired versions cannot be recovered from current-state queries, so the application must retain its own version high-water mark. A protected action must revalidate the selected entity, current version, and ENS policy and must not infer freshness from a cached candidate.

The Arkiv package does not schedule discovery. The server now owns durable discovery jobs in `packages/server/discovery-jobs.ts`; run `npm run worker:discovery` alongside the persistent backend. Opted-in active intents are due every minute, with bounded work, overlap leases, failure backoff and version-bound results. Publication confirmation and material edits queue work immediately; the running worker picks it up on its next tick. Manual Search now uses the same actual discovery path. A Vercel frontend alone does not run this worker. Public publication still requires its separate reviewed preview and bounded owner signature authorization; a discovery schedule cannot renew an old approval.

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

## Confirmed fictional demo records

On 6 November 2026, two separate generated test owners published these four approved intents on Rabdi, chain 7794095. Each passed canonical receipt verification, application confirmation and SDK payload read-back. The official Arkiv MCP `verify_entity` separately observed all four owners and creation/expiry block metadata at block 303325. That MCP observation does not establish application correctness or prize eligibility.

The workshop recruiter subsequently published approved revision 2 for the same logical intent `635da455-bab3-41b6-97cf-d43fa9a95ad0`: [transaction](https://rabdi.explorer.arkiv.network/tx/0xe2a7208e626d304e353ceabe9a2db973b0e515c15226593e182f3e131de9fb99), entity `0x4485da1e5050e5d547e72c516c04e2ef9daebd9da386ca2c8e36f8974baebf8b`, block 306425. The exact correction changes an incorrectly extracted mandatory condition to preferred, preserving the public text and expiry. Historical revision 1 remains visible on-chain but is not the current application revision. Fresh queries selected revision 2 in both directions; actual Nomic embeddings produced cosine 0.8501236543818352 despite no exact tag overlap. Both results are possible matches with unresolved preferences, not consent. One local embedding request processed 33 tokens; the reverse query reused two cached vectors after fresh Arkiv and ENS checks. Coverage was bounded at twelve candidates and was not exhaustive.

| Intent | Entity key | Transaction |
| --- | --- | --- |
| DevRel job seeker | `0x814a8b6a7cda9fce6da3f65d5764d461aa2b3d8bdf7d67befb20efbdce9647aa` | `0x638379d3c25c6394851276206bb3416eecc9cf2c21117543f05612e9eae2b961` |
| Developer advocacy recruiter | `0x85779269b4d42adb1b1ee0b73f960389f3ebc08b8ce3ee14c87914ab8869aed0` | `0x95166406dcbb1c148c1e4ab2f3016851c571890e172d2e66949edabe4145a42b` |
| Workshop writing collaborator | `0xae1d9e9779a65765d664ab9ff4c7a7b38832f1c26c855cbfcb0eb9c4f4a6a424` | `0x9656bd1b997796f5c6d4a2abbd5f278932a2f00725b6a223682b34782a3ee949` |
| Workshop live-coding collaborator | `0x01071f4930ce4d80f1c9e656b97c26014e4fab81e813d01c15b1c929c259a9a8` | `0x7749bc2bb7d7501389dcfe0f65b18ebff074e0c7dac6ac68f02d79e2a466d8cc` |

These records expire 24 hours after their respective draft creation on 6 November. A later empty query is not evidence that they never existed. Reproduction requires currently active, separately approved test records after expiry. To query the existing public fictional records while active:

```powershell
$env:ARKIV_INCLUDE_DEMO='1'
npm run arkiv:query -- collaborator
```

Actual application discovery found the DevRel seek/hire pair in both directions despite zero exact tag overlap. Local `nomic-embed-text:v1.5` produced 768-dimensional vectors and cosine 0.8924824531220792. The first comparison used one real 52-token embedding request; the reciprocal comparison reused two cached vectors after fresh Arkiv and ENS checks. This is semantic relevance, not a compatibility probability or introduction consent. Unconfirmed soft preferences remained visible. Candidate coverage was explicitly non-exhaustive, capped at twelve. All accounts are fictional and are not World verified.

### Free CPU deployment model verification

On 7 November, the production build in Vercel mode used the migrated Supabase accounts and queried actual Rabdi blocks 311769 and 311798. Both DevRel directions returned their separately owned records after live ENS checks. The pinned `Xenova/all-MiniLM-L6-v2` CPU model produced 384-dimensional vectors and cosine `0.6872726960500519`. One real embedding batch processed 46 tokens at no provider charge; the reciprocal result reused the two vectors while re-reading current chain state. Both recommendations remained `possible-match` with unresolved preferences. Coverage was capped at twelve; other candidates with failed authority checks were reported unconfirmed. This was an actual local production-server pipeline, not yet a hosted-origin acceptance claim. It used the same existing public entities and made no new blockchain publication.
