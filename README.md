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

### 1. Install the prerequisites

The commands below use Windows PowerShell. Keep the project on a writable local drive.

| Tool | Required action | Check in a new terminal |
|---|---|---|
| Git | Install from [git-scm.com](https://git-scm.com/downloads), then reopen the terminal | git --version |
| Node.js | Install Node.js 24 or a compatible newer release from [nodejs.org](https://nodejs.org/en/download); npm is included | node --version and npm --version |
| Ollama | Install from [ollama.com](https://ollama.com/download), launch the application and keep it running for local embeddings | ollama --version |
| Browser | Use a current browser; install MetaMask from its [official download page](https://metamask.io/download/) for wallet actions | Unlock the wallet yourself when needed |

If PowerShell blocks npm.ps1, use npm.cmd in place of npm in the commands below. A global execution-policy change is not required. Never enter a recovery phrase, wallet password or private key into Meeti or its terminal.

### 2. Clone the source and install dependencies

Choose the parent directory yourself, then run:

~~~powershell
git clone https://github.com/DarshanKrishna-DK/Meeti.git
cd Meeti
node --version
npm --version
npm ci
~~~

The remaining commands must run inside the folder containing package.json. If you already have this checkout, use it and preserve your local changes instead of cloning over it. npm ci uses package-lock.json; no separate frontend or backend install is needed.

### 3. Create local configuration and private storage

~~~powershell
npm run setup
~~~

Setup creates .env.local from [.env.example](.env.example) only when missing, generates a random DATA_ENCRYPTION_KEY and creates .local-data. Open .env.local in your editor. Do not replace the generated key with the blank example, and do not regenerate a key for an existing encrypted database. Back up the database and key together in private storage. No provider credentials are installed by this command.

### 4. Configure real services

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

For the currently verified Groq model, create your own key in [Groq Console](https://console.groq.com/keys), confirm the model is enabled for your organization, and set the following nonsecret configuration plus your private AI_API_KEY. These are explicit provider settings, not an automatic fallback:

~~~dotenv
AI_BASE_URL=https://api.groq.com/openai/v1
AI_MODEL=openai/gpt-oss-20b
AI_RESPONSE_FORMAT=json_schema
AI_TASK_RESPONSE_FORMATS={"evaluate_compatibility":"json_schema","agent_clarification":"json_schema"}
AI_REASONING_EFFORT=low
AI_MAX_OUTPUT_TOKENS=4096
AI_INPUT_USD_PER_MILLION=0.075
AI_OUTPUT_USD_PER_MILLION=0.30
AI_MAX_REQUESTS=24
AI_MAX_COST_USD=0.05
~~~

The token prices are the documented model prices checked on 6 November 2026. Your account plan, model permissions and rate limits still apply. Review [current Groq pricing and model support](https://console.groq.com/docs/model/openai/gpt-oss-20b) before changing providers or enabling paid usage. Keep the key server-side and do not paste it into source code.

Get an Arkiv access key through the links in the [official networks hub](https://hub.arkiv.network/networks). Set ARKIV_ACCESS_KEY in .env.local. Rabdi chain ID is 7794095; the SDK derives its keyed URL from this key. Use the hub's current faucet for test GLM in the wallet that will publish. ENS operations use Sepolia 11155111 and require test ETH. Do not send real funds to either testnet setup.

### 5. Install and verify the embedding model

With Ollama running, open a terminal and run:

~~~powershell
ollama pull nomic-embed-text:v1.5
ollama list
~~~

If Ollama is not already listening, run ollama serve in a separate terminal. If it reports the port is already in use, check the existing Ollama application instead of starting competing servers. Keep the service running while Meeti uses local embeddings.

Read the actual installed digest using PowerShell:

~~~powershell
$modelInventory = Invoke-RestMethod http://127.0.0.1:11434/api/tags
$modelInventory.models | Select-Object name, digest
~~~

Copy the exact digest for nomic-embed-text:v1.5 into EMBEDDING_MODEL_REVISION. Confirm these fields in .env.local:

~~~dotenv
EMBEDDING_PROTOCOL=ollama
EMBEDDING_BASE_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=nomic-embed-text:v1.5
EMBEDDING_DIMENSIONS=768
EMBEDDING_INPUT_USD_PER_MILLION=0
EMBEDDING_MAX_COST_USD=0
EMBEDDING_MAX_REQUESTS=48
EMBEDDING_TIMEOUT_MS=30000
EMBEDDING_MAX_BATCH=16
EMBEDDING_RETRIES=1
~~~

EMBEDDING_MODEL_REVISION must contain your actual digest, not a placeholder. A tag can point to a different manifest on another installation. Calibrate the configured model and format using only the development set:

~~~powershell
node --env-file=.env.local --import tsx packages/matching/evaluate-live.ts calibrate
~~~

Copy the returned threshold into MATCHING_MIN_COSINE, modelRevision into MATCHING_CALIBRATED_REVISION and format into MATCHING_CALIBRATED_FORMAT. Keep EMBEDDING_MODEL_REVISION equal to that modelRevision. Save .env.local. This command calls your real local embedding model and does not publish anything or call the paid reasoning provider. A model/revision/format change needs a fresh development calibration; do not tune against held-out outcomes to force a pass.

Optionally evaluate the held-out examples separately:

~~~powershell
npm run matching:live -- embeddings-v2
~~~

The existing measured threshold is evidence for its recorded model manifest, not a universal default. A failed calibration or unavailable model is a setup failure, not permission to substitute fake embeddings.

### 6. Initialize the database

After saving the configuration, run:

~~~powershell
npm run db:migrate
~~~

This creates the schema at DATABASE_PATH. It does not create funded wallets, ENS names, public intents, matches or verification. Never copy .env.local or .local-data into GitHub. If a database was created with another encryption key, restore its matching key rather than deleting data to hide the error.

### 7. Run the application

~~~powershell
npm run dev
~~~

Open **http://127.0.0.1:3173**. For an optimized local build:

~~~powershell
npm run build
npm run start
~~~

Keep the laptop awake while it supplies the backend or model. A healthy API is not, by itself, end-to-end proof.

In a second terminal, check the actual local server:

~~~powershell
npm run demo:doctor
Invoke-RestMethod http://127.0.0.1:3173/api/health
~~~

Keep the server terminal running. Stop it with Ctrl+C before switching between development and production or starting another server on port 3173. Configuration changes require a server restart. Do not run a production build over an active production server's .next directory.

### 8. Create an account and complete the current setup

This checkpoint uses an account followed by explicit wallet ownership linking. Create an account in the local interface, save your private profile and choose public visibility separately. Unlock MetaMask yourself, select the intended wallet and approve only the displayed ownership message. Connecting a wallet alone does not register an ENS name or authorize a public transaction.

Use a real Sepolia ENSv2 parent name and the dedicated agent namespace/resolver setup for protected discovery. The independent CLI can inspect a registration quote without signing:

~~~powershell
node --env-file=.env.local --import tsx packages/ens/register-parent.ts quote your-test-name.eth YOUR_WALLET_ADDRESS
~~~

Replace both arguments with your own values. This only reads a quote. Registration, resolver/delegation changes and Arkiv publication require separately reviewed wallet transactions. Follow the [official ENSv2 Sepolia tutorial](https://docs.ens.domains/ensv2/tutorial-app-developers/) for current deployment details. Missing names or funding must remain visible blockers, rather than decorative identities.

The upcoming guided MetaMask-first onboarding is not claimed by this checkpoint. The README will be updated again when that flow is implemented and verified.

### Troubleshooting local startup

| Symptom | Action |
|---|---|
| node or npm is not recognized | Reopen the terminal after installation and check PATH using the official installer |
| Port 3173 is already in use | Reuse the healthy Meeti server or stop its own terminal; do not kill unrelated Node processes |
| Wrong origin or session will not save | Use exactly APP_ORIGIN, including hostname and port; do not mix localhost and 127.0.0.1 |
| Decryption failed | Restore the original DATA_ENCRYPTION_KEY for that database |
| Embedding model/dimensions/revision mismatch | Verify Ollama inventory, pin its actual digest and rerun development calibration |
| AI 401, 403 or 429 | Check the configured key, organization model access and provider quota; do not fabricate a result |
| Empty discovery | Confirm an approved public intent is active, the scope is eligible and current ENS permissions pass; enable fictional records only for an intentional test |
| World is paused | Expected until organizational access and real client registration are resolved |

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
