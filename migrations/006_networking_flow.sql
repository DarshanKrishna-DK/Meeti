CREATE TABLE IF NOT EXISTS qualifications (
  id TEXT PRIMARY KEY,
  left_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  right_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qualifications_left ON qualifications(left_user,updated_at);
CREATE INDEX IF NOT EXISTS qualifications_right ON qualifications(right_user,updated_at);
CREATE TABLE IF NOT EXISTS profile_intakes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_plans (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_jobs (
  intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  binding TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  result TEXT,
  checked_at TEXT,
  failure_code TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS discovery_due ON discovery_jobs(enabled,next_run_at);
CREATE TABLE IF NOT EXISTS discovery_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_registrations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
