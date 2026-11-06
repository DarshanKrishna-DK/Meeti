# Public intent schema

Meeti: Good connections begin with a little intent.

Network: Rabdi, chain ID `7794095`. SDK: `@arkiv-network/sdk@1.0.1`. Named schema: `meeti.public_intent.v2`. The schema name is a public convention, not authentication. Existing v2 signatures and decoding remain unchanged.

| Column | SDK type | Indexed | Meaning |
| --- | --- | --- | --- |
| intentId | str | Yes | Opaque application intent identifier |
| ensAgentRef | str | No | Public ENS agent namespace reference |
| goal | str | Yes | cofounder, collaborator, mentor, or teammate |
| visibility | str | Yes | Always public |
| optIn | bool | Yes | True for active records, false for a signed closed revision |
| owner | addr | Yes | Signed owner reference, checked against protected owner and creator |
| version | u64 | Yes | Positive immutable intent revision |
| policyVersion | u64 | No | Required ENS policy revision |
| createdAt | u64 | No | UTC application timestamp in milliseconds |
| expiresAt | u64 | Yes | UTC application deadline in milliseconds |
| demoOrigin | bool | Yes | Fictional-profile provenance |
| schemaVersion | u64 | Yes | Always 2 for this public schema |
| status | str | Yes | active or closed |
| direction | str | Yes | Approved relationship direction from semantics v1 |
| category | str | Yes | Same purpose category as goal |
| canonicalRole | str | Yes | Conservative role alias label, first 32 UTF-16 code units |
| tag0 through tag7 | str | Yes | Sorted unique lowercase topic labels, unused slots empty |
| envelope | bytes | No | Canonical public projection and owner signature |

The SDK adds the indexed `arkiv.schema` tag. Every create uses `readonly: true` and `permissionlessExtension: false`. Values are immutable; owner transfer or deletion can still affect availability. Discovery checks `$owner`, `$creator`, `$creationFlags`, `$expiresAt`, every selected public column, and the owner signature. A copied tag, supplied owner column, or unsolicited transfer cannot establish authorship.

The canonical signed projection contains the fields above plus explicitly approved public `summary` and structured `semantics`. Semantics v1 carries category and direction evidence, a requested role, topics, explicitly claimed offers, and preferred, mandatory or unknown requirements with literal source quotes. Only approved public text and those approved quotes are published. It permits no additional properties. It contains no employer, contact details, private identity, agent conversation, unapproved raw prompt, or private profile field. UTF-8 string limits, a 16 KiB signed envelope limit, and a 30-day application lifetime bound are enforced before transaction preparation and during reads. Summary, semantics and tags remain public even when stored in an unindexed bytes column. Signed content is inert data.

No separately typed profile location or language field exists in v2. A location requirement can use the existing location kind; language can only use other. Offers are untyped claims. The bilateral matcher requires equal normalized offer text, without geographical, language proficiency, numerical, negation or range inference. A richer public profile contract needs explicit public review and a new version that preserves existing v2 decoding. Private profile context does not implicitly become public matching input.

`$expiresAt` is a chain block height. Application `expiresAt` is milliseconds. Either expired deadline rejects discovery and protected proposals. A renewal creates a newly signed next version with a later deadline. Extending chain retention alone cannot extend the signed application deadline. Transaction history or copies can remain after expiration.

The application must also verify current ENS authority, policy revision, ownership session, blocked-user policy, and intent version immediately before any protected action. An Arkiv signature proves the wallet approved a public projection. It does not prove ENS authorization, identity credentials, consent to an introduction, or World verification.

Newest-version checks read two rows ordered by version. A tie at the selected version is rejected even when both signed payloads agree, because tie order is node-defined. Older revisions may coexist with one unambiguous newer version. These checks observe current head state. Deleted or chain-expired newer revisions cannot be recovered and require the application current-key/version gate and retained version high-water mark.

Implementation: `packages/arkiv/src/index.ts`. Official references: [typed schemas](https://docs.arkiv.network/schemas/define/), [column types](https://docs.arkiv.network/schemas/column-types/), [SDK 1.0.1 source](https://unpkg.com/@arkiv-network/sdk@1.0.1/src/).
