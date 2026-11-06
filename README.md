<div align="center">

<img src="public/meeti-logo.png" width="220" alt="Meeti: two people connected by a flowing metallic M" />

# Meeti

### Good connections begin with a little intent.

**Your agent explores. You choose who gets to meet you.**

An AI networking MVP for **ETHGlobal Mumbai 2026**

![Next.js](https://img.shields.io/badge/Next.js-16-342432?style=for-the-badge&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-79445D?style=for-the-badge&logo=typescript&logoColor=white)
![ENSv2](https://img.shields.io/badge/ENSv2-Sepolia-79596C?style=for-the-badge)
![Arkiv](https://img.shields.io/badge/Arkiv-Rabdi-935E79?style=for-the-badge)
![AI](https://img.shields.io/badge/AI-Real_model_calls-79445D?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Development_MVP-B17690?style=for-the-badge)

[What it does](#what-it-does) · [How it works](#how-it-works) · [Get started](#get-started) · [Try the demo](#try-the-demo) · [Current status](#current-status) · [Deployment](#deployment)

</div>

---

## What it does

Meeti turns your reviewed networking goal into a discoverable intent. Your representative can find relevant people, discuss permitted public context and propose an introduction. A candidate is a suggestion. It is never consent.

<table>
<tr>
<td width="50%">

### Start with what matters

Describe the role, help or collaboration you need. Review the interpretation and choose exactly what becomes public.

</td>
<td width="50%">

### Find complementary intentions

Real Arkiv records supply candidates. Actual embeddings compare subjects and roles. Separate checks enforce direction, requirements and permissions.

</td>
</tr>
<tr>
<td>

### Give your agent clear boundaries

ENSv2 names and dedicated resolvers carry current authorization. Narrow delegation, expiry and revocation constrain actions independently of the model.

</td>
<td>

### Keep the final decision

Both people review the proposal. Private contact stays hidden until every required release gate passes. World is paused, so protected rooms stay locked.

</td>
</tr>
</table>

> **Development MVP:** real ENSv2 authorization, Arkiv publication and discovery, local embeddings, model-generated dialogue and contact denial have live evidence. World application and sandbox login returned HTTP 403. Automated fictional-account approvals do not establish independent human verification.

<details>
<summary><strong>See the current workspace</strong></summary>

<img src="public/readme/workspace.png" width="100%" alt="The Meeti workspace with an actual ENSv2 test identity, two approved fictional Arkiv intents and the paused World release boundary" />

This is the actual local interface using explicitly fictional test accounts and real testnet records. The permission timestamp is a historical observation. World is paused and no private room has opened.

</details>

## How it works

<img src="public/artwork/connection-instrument.svg" width="100%" alt="An explanatory two-owner networking instrument with public intent cards, a permission shutter, two approval pins and a locked release gate" />

The instrument is an illustration, not live activity. Its controls explain the workflow and cannot approve an introduction.

~~~mermaid
flowchart LR
    U["You<br/>Goal and visibility"] --> I["Review public intent"]
    I --> E{"Current ENSv2 permission"}
    E -->|Allowed| A["Arkiv Rabdi<br/>Signed expiring record"]
    A --> D["Bounded candidate retrieval"]
    D --> M["Actual embeddings<br/>Bilateral requirements"]
    M --> C["AI agents<br/>Evidence-backed clarification"]
    C --> P["Candidate introduction"]
    P --> H{"Both people approve"}
    H --> W{"Fresh World verification<br/>Currently paused"}
    W -->|All gates pass| R["Private room"]
    E -->|Denied or unknown| B["Block and explain"]
    classDef plum fill:#342432,stroke:#BFAEBC,color:#FAE9E7;
    classDef cream fill:#FFF9F5,stroke:#B17690,color:#342432;
    class U,I,A,D,M,C,P,R cream;
    class E,H,W,B plum;
~~~

**AI proposes. Current permissions decide what is allowed.** Private conversations, contacts, employer details, secrets and embedding vectors stay off public discovery records.

## Get started

### 1. Prepare the laptop

Use **Node.js 24 or later**, npm and a writable persistent directory.

~~~powershell
npm ci
npm run setup
npm run db:migrate
~~~

Setup creates .env.local only when missing. It preserves existing credentials. Use [.env.example](.env.example) as the nonsecret reference. Preserve the existing encryption key when reusing an encrypted database.

### 2. Configure real services

| Service | Required configuration | Boundary |
|---|---|---|
| Private persistence | DATABASE_PATH, DATA_ENCRYPTION_KEY | Durable SQLite directory; back up the database and encryption key together |
| Application | APP_ORIGIN | Exact canonical browser origin, initially http://127.0.0.1:3173 |
| ENSv2 | ENS_SEPOLIA_RPC_URL, optional ENS_SEPOLIA_AUTH_RPC_URL | Sepolia 11155111; actual names, dedicated resolvers and current grants |
| Arkiv | ARKIV_ACCESS_KEY | Rabdi 7794095; SDK builds its keyed RPC URL; publishing wallet needs test GLM |
| Agent reasoning | AI_BASE_URL, AI_API_KEY, AI_MODEL, response format and budget settings | Server-side provider with actual structured calls and source validation |
| Embeddings | EMBEDDING_* plus MATCHING_MIN_COSINE, MATCHING_CALIBRATED_REVISION and MATCHING_CALIBRATED_FORMAT | Exact model revision and dimensions; calibration must match |
| World | WORLD_CAPABILITY_ENABLED=false | Keep disabled while organizational access is blocked |

The current laptop uses **Ollama nomic-embed-text:v1.5, 768 dimensions**, and configured **Groq openai/gpt-oss-20b** reasoning. There is no vector database. The bounded embedding cache rebuilds after restart and never replaces Arkiv authority. Provider failures do not produce fabricated matches.

Normal publishing uses the connected wallet after review. A server wallet private key is not required. ARKIV_PRIVATE_KEY belongs only to a separately approved local test executor and must not be deployed to a frontend. Never put secrets into NEXT_PUBLIC_* variables.

### 3. Run the application

~~~powershell
npm run dev
~~~

Open **http://127.0.0.1:3173**. For an optimized local build:

~~~powershell
npm run build
npm run start
~~~

Keep the laptop awake while it supplies the backend or model. A healthy API is not, by itself, end-to-end proof.

## Try the demo

### Separate sessions matter

Normal windows and tabs in one browser profile share cookies. Use **two browser profiles**, **a normal and private session**, or **separate devices**. Sign in to different accounts with distinct linked wallets. Do not copy one session cookie into both participants' contexts.

The same person can use their account on mobile and laptop through one shared backend. Saved state refreshes when returning to the page and while it is visible. Unsaved form drafts stay local. Refresh never signs, publishes, approves or starts agent reasoning automatically. Profile changes intentionally invalidate proposals bound to the earlier profile snapshot, so finish your demo profile before requesting an introduction.

### A dynamic demonstration

1. **Profile:** save different headlines for both accounts. Reload to show persistence and account isolation. Keep contact and employer private.
2. **Agent studio:** inspect each actual ENSv2 identity and current narrow authorization.
3. **Intent:** use a fictional DevRel job seeker and a differently worded developer-advocacy recruiter. Review direction, public fields and expiry. Publish only after a deliberate wallet decision with test funding.
4. **Discover:** retrieve actual Arkiv records. Enable labelled demo records for the existing fictional accounts. Show entity IDs, record versions, bounded coverage and relevance. Another job seeker must not become a hiring match because the words are similar.
5. **Agent exchange:** request a proposal and show the actual dialogue and cited evidence. Allow several minutes for permission checks and reasoning. The previous complete API acceptance run took about four minutes.
6. **Approvals:** review independently in both sessions. Observe saved decisions across sessions. Contact stays private. While World is paused, both approvals still cannot open a protected room.
7. **Revocation:** after a fresh owner-approved testnet action, show genuine ENS denial on the next protected request. Restore only through a reviewed owner action. Never replay an old transaction.

Prepare both profiles before the proposal segment. Changing an intent, profile or permission later intentionally invalidates the older proposal and consent snapshot. Use that as a separate stale-state demonstration, rather than changing the happy-path accounts halfway through approval.

The three existing live fictional records have an approved twenty-four-hour lifetime. Expired data must disappear rather than be silently reseeded. New publication, renewal and public edits require fresh review and applicable signing authorization.

### What to test before presenting

- Visit landing, sign-in/onboarding, dashboard, profile, agent studio, intents, discovery, exchange, approvals, introductions, verifier and settings.
- Check phone navigation, 320px and 390px layouts, keyboard focus, long identifiers, reduced motion and the SVG fallback without WebGL.
- Test no candidates, incompatible directions, self-match rejection, missing mandatory facts, denied permissions and unavailable providers.
- Confirm that private profiles, audit, exports and proposal membership do not leak between accounts.
- Save and reload profile changes. Confirm another visible session refreshes without overwriting its unsaved form.
- Show a real transaction receipt and readback, rather than only a prepared transaction or wallet notification.
- Confirm that paused World never becomes a verification claim, contact release or usable room.

## Current status

| Area | Evidence and remaining boundary |
|---|---|
| Authentication and private profiles | Actual HTTP persistence and isolated session checks; encrypted at rest |
| ENSv2 | Two actual Sepolia namespaces, reciprocal narrow writes, forbidden-operation reverts, revocation, genuine API denial and restoration verified |
| Arkiv | Three approved fictional Rabdi publications, successful receipts, signed owner/creator association and actual SDK readbacks |
| Semantic discovery | Real Nomic calls; positive paraphrase without exact tag overlap; incompatible seeker excluded; cold-cache rebuild verified |
| Finite held-out evaluation | Sixteen triplets: top rank 14/16, precision 16/19, recall 16/16; three false positives retained; English coverage only |
| AI agents | Actual structured compatibility and two isolated model-generated turns with exact source validation |
| Consent and disclosure | Actual private-contact denial and automated fictional-account approvals; independent humans remain a separate gate |
| World and rooms | Preserved implementation, explicitly disabled after login HTTP 403; genuine proof and protected release remain pending |
| Public lifecycle | Expiry and freshness checks implemented and fixture-tested; natural live expiry and additional approved edit/closure tests pending |
| Deployment | Local application; Vercel needs durable backend architecture or reviewed persistence/provider migration |

<details>
<summary><strong>Limitations worth knowing</strong></summary>

- Similarity is not a compatibility probability. Direction, mandatory evidence and authorization are separate checks.
- Discovery is bounded and cannot prove exhaustive coverage or global history of deleted records.
- Public data can be copied. Expiry and revocation cannot erase previous downloads.
- Provider, quota and malformed-output failures are visible. There is no fabricated or silent lexical fallback.
- SQLite currently supports one persistent backend. Account recovery, verified email, wallet rotation and horizontal deployment remain production work.
- No outreach, calendar bookings or contact messages are sent. Synthetic records remain explicitly fictional.
- Finite English evaluations do not establish multilingual quality, credentials or guaranteed accuracy.

</details>

## Deployment

**Do not deploy the current full app unchanged as a Vercel function.** The SQLite database requires persistent storage. A cloud function also cannot reach this laptop's loopback Ollama service. [Vercel confirms the local SQLite limitation](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel).

Choose a reviewed architecture after local acceptance:

- **Vercel frontend with persistent HTTPS backend:** retain SQLite on a durable host and provide a same-origin API proxy plus reachable embedding service. Proxy and hosting configuration still need implementation and verification.
- **Vercel with managed persistence:** migrate the database adapter and transactions, then configure a reachable embedding provider with explicit model, revision, dimensions, quotas and approved cost. This migration is not currently implemented.

Prepare Vercel project access, the chosen backend/database host, and the server-side variables listed above. A GitHub-connected dashboard deployment does not require sharing a Vercel token with the app. CLI automation may use a separately scoped VERCEL_TOKEN; it is not a frontend runtime credential. Tokens alone do not solve persistent storage.

Set APP_ORIGIN to the final HTTPS URL. Preserve DATA_ENCRYPTION_KEY when moving existing data. Keep Arkiv and AI keys on the backend. World will later require accepted organization access and the correct client credentials. Never upload a wallet private key as a public frontend variable.

Before hosting, Android optionally supports the same loopback URL through an authorized USB connection:

~~~powershell
adb reverse tcp:3173 tcp:3173
~~~

Use http://127.0.0.1:3173 on both devices. Physical-phone access has not been verified in this redesign. See [Android's local-server guide](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server). Mobile signing requires a compatible wallet browser, such as [MetaMask's built-in browser](https://support.metamask.io/configure/wallet/how-to-use-the-metamask-mobile-browser/), rather than ordinary phone Chrome.

## Build and verify

~~~powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run check:secrets
npm run demo:doctor
~~~

Run npm run demo:doctor -- --target=vercel to see the current deployment blockers. This read-only check does not perform model inference, wallet signing, chain writes or World requests.

Browser tests use an isolated database and port 3198. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium executable if needed. Fixture checks do not establish live sponsor success. Real-provider drivers remain separate and do not authorize extra public writes.

Latest local validation on 6 November 2026: **333 fixture tests and 20 browser cases passed**, together with lint, typecheck and the production build. Browser checks cover forty authenticated route/viewport combinations, separate sessions, delayed-response races, draft conflicts, time zones, WebGL and fallback. Physical-phone and eventual deployed-origin checks remain separate. These results are local evidence, not a continuously running GitHub CI badge.

<details>
<summary><strong>Project map and repository hygiene</strong></summary>

~~~text
app/                  Pages, metadata and API route
components/           Product interface and original artwork
packages/agents/      Structured reasoning and agent exchanges
packages/arkiv/       Signed publication and authoritative discovery
packages/ens/         ENSv2 resolution, policies and narrow permissions
packages/matching/    Vocabulary, embeddings and bilateral ranking
packages/server/      Authentication, encryption, persistence and consent
packages/shared/      Typed application contracts
packages/world/       Preserved integration, currently disabled
migrations/           Database schema
public/               Logo, fonts, license notices and artwork
tests/ and e2e/       Isolated regression and browser checks
arkiv/                Required public sponsor materials
scripts/              Setup and verification utilities
.env.example          Configuration names without credentials
~~~

Private docs, internal logs, local agent setup, credentials, databases, journals, model downloads, screenshots, reports and build output are excluded from Git. Needed local evidence is retained. Source tests, migrations, font licenses, third-party notices and public sponsor materials remain publishable. Ignoring a file does not remove an existing remote copy.

</details>

## Safety by design

- **Current authority:** model output cannot override ENS revocation.
- **Deliberate public data:** exact reviewed payloads, signatures and creator association establish provenance; a copied tag does not.
- **Bilateral decisions:** one person's approval cannot substitute for the other.
- **Private by default:** nonpublic fields remain encrypted and excluded from unauthorized provider projections.
- **Honest identity:** World cannot establish professional credentials or compatibility, and disabled verification never counts as success.

---

<div align="center">

**Meeti**

A little more intention. A better first introduction.

Next.js · TypeScript · ENSv2 · Arkiv · Human decisions

<sub>Respect the event build period and submission rules. Publish only after reviewing the code, hosting architecture and genuine evidence. Third-party notices are retained in THIRD_PARTY_NOTICES.md.</sub>

</div>
