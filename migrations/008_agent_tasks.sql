CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('propose','resume','retry')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted','expired')),
  input_digest TEXT NOT NULL,
  data TEXT NOT NULL,
  lease_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_task_per_owner ON agent_tasks(user_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS agent_tasks_due ON agent_tasks(status,created_at,id);
CREATE INDEX IF NOT EXISTS agent_tasks_by_owner ON agent_tasks(user_id,created_at);
