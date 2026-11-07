# What I would improve in Arkiv

Meeti: Good connections begin with a little intent.

## Semantic discovery for agents

The biggest improvement I would like is a documented path from Arkiv records to semantic search. My agents need to understand what someone means, even when two people use different words.

For example, one of my test users is looking for a DevRel role. Another is hiring a developer advocate. Exact topic matching can miss this connection. Making every optional tag a required filter would remove a useful candidate before the semantic comparison even starts.

I worked around this by retrieving a bounded set of active, complementary intents from Arkiv and comparing their approved public text with real embeddings in my backend. Arkiv stores the structured intent and indexed tags. My backend creates and temporarily caches the vectors. I did not store embeddings in Arkiv or use an Arkiv-native vector index.

I would find first-class guidance or supported tooling for storing versioned embeddings and querying them by similarity useful. I would want model and dimension metadata, filtering before ranking, pagination, and clear behavior when the source entity changes or expires. Storing vector bytes alone would not solve the nearest-neighbor query problem. I am requesting this capability, not claiming Arkiv has no way to represent vector data.

To reproduce my retrieval concern:

1. Publish a seeking-job intent about DevRel and a hiring intent about developer advocacy, using different topic tags.
2. Query with an exact shared-tag requirement. The records can be relevant without sharing that tag.
3. Query broadly by active state, compatible direction and category, then embed the public summaries in the backend.
4. Compare the results. In my real test runs, the broader retrieval path allowed a semantic comparison that exact tags alone would miss.

My expected outcome is a clear, supported recipe for hybrid retrieval. The current implementation needs application code to connect structured queries, embeddings, model versions and expiry-aware cache invalidation.

## Other friction I encountered

- I encountered historical examples alongside current SDK guidance. A single version-labelled SDK 1.0.1 example covering publish, wallet confirmation, read-back and pagination would have saved time.
- SDK expiry is represented on-chain by blocks, while my users choose a date and time. I check both the application deadline and chain lifetime. A worked example explaining this boundary would help.
- Query pages observe a moving chain head. I report bounded coverage rather than a complete snapshot. A documented pagination consistency recipe would make this easier to explain and implement.
- Transport errors can contain keyed RPC URLs. I suppress raw errors to keep credentials out of logs. Redacted SDK diagnostics would make troubleshooting safer.

These are observations and requests from building Meeti, not claims about prize eligibility. My application uses SDK 1.0.1 on Rabdi, chain 7794095.
