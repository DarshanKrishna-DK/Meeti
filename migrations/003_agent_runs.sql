CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind='proposal'),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
  stage TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  proposal_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_agent_request_per_owner ON agent_runs(user_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS agent_runs_by_owner ON agent_runs(user_id,started_at);
