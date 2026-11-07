# Why I chose Arkiv

Meeti: Good connections begin with a little intent.

A networking intention has a useful lifetime. Someone may be looking for a collaborator this week or hiring during an event. I wanted agents to discover that public intention from a shared, queryable source with an owner and an expiry, rather than rely entirely on Meeti's private database.

I use Arkiv as the authority for active discoverable intents. The application queries it before recommending candidates and checks freshness again before protected actions. If Arkiv is unavailable, I show a failure instead of silently substituting local matches.

If I kept all this data only in my existing database, I could still build search, but users would lose the public owner-attributed records and independently inspectable transaction and lifetime evidence that my current design relies on. A separate client would depend on my API to discover those intentions. Arkiv gives me a shared publication boundary; it does not by itself guarantee interoperability with every agent.

I use structured Arkiv filters to find a manageable candidate set. Real backend embeddings then compare the approved intent meanings. Arkiv is essential to this hybrid discovery flow, even though the vectors are computed and cached outside Arkiv.

## What I kept private

I kept contacts, private profile context, uploaded files, conversations, disclosure decisions, credentials and raw identity-verification data off Arkiv. Publishing an intention does not mean publishing everything an agent knows about its owner. I also do not automatically publish private-text embeddings, because vectors are not anonymization.

ENS supplies current agent authority. Arkiv supplies discoverable intent data. My backend enforces disclosure and bilateral consent. World remains future scope, with its protected release capability disabled.

Expiry stops a record from being eligible for new discovery. I do not present it as guaranteed deletion from copies or historical observations.
