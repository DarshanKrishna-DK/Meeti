# How I use Arkiv in Meeti

Meeti: Good connections begin with a little intent.

I use Arkiv as the authoritative source of active public networking intentions. My application uses `@arkiv-network/sdk` 1.0.1 on Rabdi, chain 7794095. The runtime integration is in `packages/arkiv/src/index.ts`; MCP documentation access is separate from those application reads and writes.

## What I store and filter

My named schema is `meeti.public_intent.v2`. I store an approved public summary and structured semantics, plus an owner reference, ENS agent reference, stable logical intent ID and revision. The indexed columns include:

- `intentId`, `owner`, `version` and `schemaVersion` for identity and revision lookup.
- `direction`, `category`, `goal` and `canonicalRole` for broad candidate retrieval.
- `tag0` through `tag7` for bounded topic filters.
- `visibility`, `optIn`, `status`, `demoOrigin` and `expiresAt` for eligibility and scope.

The larger signed public payload stays in a bytes column. I verify that its fields agree with the indexed values. A copied schema tag or an application-level owner field is not enough: I also verify the owner signature and Arkiv's protected owner and creator association.

I store tags and structured intent data in Arkiv. I do not store vectors there. Semantic comparison uses actual backend embeddings, with a bounded, rebuildable in-memory cache. In the verified hosted DevRel run, the model was `Xenova/all-MiniLM-L6-v2`, with 384 dimensions. This is hybrid retrieval using Arkiv records, not Arkiv-native vector search.

## Publication and editing

The user reviews the public fields and expiry before signing the exact intent projection. My backend checks the authenticated owner and current ENS authority, then prepares a bounded unsigned Arkiv transaction. The wallet separately approves the chain write.

I mark publication confirmed only after checking a successful receipt and reading the real entity back. An unsigned preparation, pending transaction or failed RPC request does not become a published intent in the interface.

My application accepts edits only from the authenticated intent owner. An edit creates a new reviewed revision, followed by a separate public write. I use signed revisions and current-version checks instead of treating old public records as automatically current. Closing an intent stops local matching immediately; the public closure revision still needs its own confirmed write. Public historical records may remain visible.

## Expiry and discovery

The user chooses a UTC deadline, and I pass the expiry through the SDK's `ExpirationTime.atDate`. The reader checks the public deadline and the chain lifetime. Demo records were created with 24-hour validity. A renewal requires a later expiry and a new owner-approved revision.

My broad queries filter active, opted-in, public records by compatible direction and category. Optional tags can refine retrieval, but I do not require all tags to overlap. Two job seekers are excluded as a hiring pair even if their summaries are nearly identical.

The adapter permits up to five pages of 100 entities. The matching backend evaluates a bounded candidate set, currently capped at twelve, and reports coverage rather than claiming exhaustive search. It rechecks relevant Arkiv state and ENS authority before protected actions. Expired, superseded, unauthorized or ambiguous records cannot become an introduction just because an embedding is similar.

For a configured local application, this command reads real public fictional test records while they remain active:

```powershell
$env:ARKIV_INCLUDE_DEMO='1'
npm run arkiv:query -- collaborator
```

The server-side access key belongs in local environment configuration, never in the command output or browser bundle. After the demo records expire, an empty result is expected unless new records are separately approved and published.

## What these features change for my users

| Arkiv feature | What a user sees |
| --- | --- |
| Confirmed publication and read-back | A real published state and an inspectable transaction, rather than optimistic success |
| Indexed direction and category | Candidates with a complementary purpose, rather than every similar-looking profile |
| Public topic and intent data | Semantic ranking grounded in actual retrieved records |
| Ownership and signature checks | Another wallet cannot impersonate a trusted intent simply by copying its tag |
| Revisions and freshness checks | Edited or closed intentions stop qualifying as old recommendations |
| Entity lifetime and public expiry | Time-limited discovery instead of stale intentions remaining active indefinitely |
| Bounded pagination and failure reporting | Honest coverage and retry states instead of fabricated matches |

## Confirmed public examples

These are fictional test accounts and historical confirmed publications, not claims that the records remain active forever.

| Example | Entity | Confirmed transaction |
| --- | --- | --- |
| DevRel job seeker | [Entity](https://rabdi.explorer.arkiv.network/entity/0x814a8b6a7cda9fce6da3f65d5764d461aa2b3d8bdf7d67befb20efbdce9647aa) | [Receipt](https://rabdi.explorer.arkiv.network/tx/0x638379d3c25c6394851276206bb3416eecc9cf2c21117543f05612e9eae2b961) |
| Developer advocacy recruiter | [Entity](https://rabdi.explorer.arkiv.network/entity/0x85779269b4d42adb1b1ee0b73f960389f3ebc08b8ce3ee14c87914ab8869aed0) | [Receipt](https://rabdi.explorer.arkiv.network/tx/0x95166406dcbb1c148c1e4ab2f3016851c571890e172d2e66949edabe4145a42b) |
| Workshop collaborator, revision 2 | [Entity](https://rabdi.explorer.arkiv.network/entity/0x4485da1e5050e5d547e72c516c04e2ef9daebd9da386ca2c8e36f8974baebf8b) | [Receipt](https://rabdi.explorer.arkiv.network/tx/0xe2a7208e626d304e353ceabe9a2db973b0e515c15226593e182f3e131de9fb99) |

The workshop revision confirmed at Rabdi block 306425. My later hosted DevRel discovery queried actual Arkiv blocks 314475 and 314476, made a real 46-token embedding batch and returned a possible match with cosine similarity 0.6872726960500519. This is a measured semantic score, not a compatibility probability or consent. Other local runs used a different Nomic model; their scores are separate measurements and are not interchangeable.

The complete hosted onboarding-to-agent-conversation flow is still unfinished. I have not completed a fresh natural-expiry acceptance test or independent-human end-to-end acceptance. World stays paused, and protected contact release remains unavailable. Those limits do not turn earlier confirmed testnet receipts into simulated evidence, but the receipts alone do not prove the whole product works.

For the exact schema and implementation details, see [schema.md](schema.md), `packages/arkiv/src/index.ts`, `packages/server/discovery.ts` and `arkiv/query.ts`.
