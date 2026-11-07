-- Incremental upgrade for an existing private Meeti database.
CREATE TABLE meeti_private.auto_qualification_batches (
  __row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES meeti_private.users(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL REFERENCES meeti_private.intents(id) ON DELETE CASCADE,
  intent_version INTEGER NOT NULL,
  entity_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','searching','qualifying','completed','no_candidates','blocked','cancelled','expired','interrupted')),
  data TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(user_id,intent_id,intent_version,entity_key)
);
CREATE INDEX auto_qualification_by_owner ON meeti_private.auto_qualification_batches(user_id,created_at,id);
ALTER TABLE meeti_private.auto_qualification_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.auto_qualification_batches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON meeti_private.auto_qualification_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE meeti_private.auto_qualification_batches___row_order_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeti_private.auto_qualification_batches TO meeti_runtime;
GRANT USAGE, SELECT ON SEQUENCE meeti_private.auto_qualification_batches___row_order_seq TO meeti_runtime;
CREATE POLICY server_access ON meeti_private.auto_qualification_batches TO meeti_runtime USING (true) WITH CHECK (true);
