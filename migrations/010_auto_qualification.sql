CREATE TABLE IF NOT EXISTS auto_qualification_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS auto_qualification_by_owner ON auto_qualification_batches(user_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_auto_qualification_per_owner ON auto_qualification_batches(user_id) WHERE status IN ('queued','searching','qualifying');
