# Reach and publication evidence

Meeti: Good connections begin with a little intent.

Measured adoption, external users, and public distribution: not measured. No numerical reach claims are made.

| Evidence | Current result |
| --- | --- |
| Focused local trust, unsigned SDK and current-query tests | 29 passed on 2026-11-06, `npx vitest run packages/arkiv/src/index.test.ts`; fixtures only |
| Missing-key query command | Returned the configuration error and no synthetic rows on 2026-11-06 |
| Rabdi chain-ID probe through official MCP | Observed chain ID 7794095 on 2026-11-06; chain-ID scope only |
| Application writer addresses | 0x9253705482a44e6A7378163e57cc791AE6213ed5 and 0xEE291Bc0246441F53610FbCAF2bC892110e72732; owner-authorized fictional test accounts |
| Application entity keys | Three real keys and owner associations recorded in docs/prize-evidence.md and artifacts/live-hybrid-evidence.json |
| Successful application transaction hashes | 0xadcc9888773a3678b2f1547bb11fd8933952775e9cbb460533f0515a4866a715, 0x1494ca2bf6f9393c1d1f18f1070d2825fe7947c0826c66fe49448413c223ce2c and 0xdf43c43d9271c443aedb5330764ef4f9f4910bbce13ce07cfdf781404d7c9c2f |
| Live application discovery result and observed blocks | Three records read at 288270 and 288271; bounded complementary discovery at 288278 and 288279 returned the recruiter and excluded the incompatible seeker |
| Two-owner live UI discovery | Desktop actual recruiter-to-seeker discovery passed, possible match similarity 0.973; incompatible seeker returned an honest empty state; no exact positive tag overlap |
| Live expiry and renewal evidence | Pending |
| External independently verified client discovery | Pending |

The runnable query is `arkiv/query.ts`. The actual full API driver is `scripts/verify-live-matching.ts verify`. It passed real ENS checks, Arkiv reads, semantic ranking, model-generated proposal, private-contact denial and two explicitly automated fictional-account approvals. World remained disabled and no room or human-verification claim was created. Actual discovery and counterpart disclosure then returned genuine ENS authorization denial while the owner grant was revoked. Natural expiry and additional publication lifecycle tests remain pending. Empty evidence cells are not replaced by fabricated hashes or sample explorer links.

Read-only package audit at `2026-11-06T15:28:36.586Z`: all three existing SDK records passed signature/index/current-version checks at Rabdi 296560 and 296561, independent current ENS discover checks allowed both namespaces at Sepolia 12077445, and the real hiring query returned only the existing recruiter at Rabdi 296572. Real local Nomic inference reproduced cosine `0.9725795153090757`, denied the incompatible direction before embedding, and reused two cached vectors after another model digest inventory check. MCP independently observed all three public metadata records at 296369. This package verification used recorded public ENS references. It does not prove current inbox mapping or new application session E2E against the fresh onboarding database, independent-human approvals, natural expiry, World or room release. No new chain write or signature occurred.
