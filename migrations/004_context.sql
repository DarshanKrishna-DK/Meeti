CREATE TABLE IF NOT EXISTS private_context_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 1048576),
  metadata TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_context_by_owner ON private_context_documents(user_id,id);
CREATE TABLE IF NOT EXISTS private_context_shares (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES private_context_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_context_share_owner ON private_context_shares(user_id,document_id);
