# Integration friction and evidence limits

Observed on 2026-11-06:

1. The documentation agent-skill page points to `arkiv-best-practices`, while the connected official MCP marks that skill deprecated and routes SDK 1.0.x work through `skills/arkiv/skill`. The adapter uses the version-pinned SDK 1.0.1 source and current MCP errata.
2. Generated API navigation includes historical shapes. Current SDK 1.0.1 uses typed named schemas, flat `$` system fields, and `createEntity(schema, values, options, txParams)`. Legacy attributes-based examples were not used.
3. Bytes columns are returned as hexadecimal typed values, while a create can accept a `Uint8Array`. The adapter validates bounded hexadecimal data and decodes UTF-8 strictly.
4. A public schema tag or `owner` application column is forgeable. The reader requires a valid owner signature, matching protected creator/current owner, immutable fields, and matching indexes.
5. RPC keys occur in keyed transport URLs. Operator keys stay server-side; raw transport errors and nested causes are discarded. The example command never logs environment variables or transport objects.
6. Query pages read the current head independently. Bounded keyset traversal reports observed blocks and incomplete traversal rather than claiming snapshot completeness.
7. The SDK exposes write actions, while a server preparation endpoint must never send. A strict RPC allowlist intercepts unsigned estimation and blocks all transaction submission methods. The final wallet confirmation remains a separate action.
8. SDK expiration is a block height; the product deadline is a signed UTC time. Both must be live. Renewal creates another immutable version rather than editing signed public history.

The official MCP `network_status` returned Rabdi chain ID verification on 2026-11-06. That read verifies only its anonymous RPC chain-ID probe. No user wallet transaction, intent publication, successful application query, application receipt, or live expiration was created by this work. Local test outcomes are recorded separately after execution. No feedback has been submitted externally.

Upstream references: [official SDK source](https://unpkg.com/@arkiv-network/sdk@1.0.1/src/), [AI Tools Hub](https://hub.arkiv.network/ai-tools), [pagination](https://docs.arkiv.network/querying/paginate/), [expiration](https://docs.arkiv.network/writing/expiration/).
