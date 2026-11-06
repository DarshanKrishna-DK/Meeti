-- Private server persistence. Existing encrypted payloads and AAD identifiers are preserved.
-- The dedicated backend role has DML access. Opaque wallet sessions enforce tenant ownership in the backend.
-- No browser role receives access, and these tables are outside the exposed public schema.
CREATE ROLE meeti_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 8;
CREATE SCHEMA meeti_private;
REVOKE ALL ON SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
SET search_path TO meeti_private, pg_catalog;
CREATE TABLE IF NOT EXISTS users (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, wallet TEXT UNIQUE, profile TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (__row_order BIGSERIAL UNIQUE, token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intents (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, left_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, right_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, pair_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consents (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision TEXT NOT NULL, digest TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, binding TEXT NOT NULL, data TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS blocks (__row_order BIGSERIAL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(user_id,blocked_id));
CREATE TABLE IF NOT EXISTS audit (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (__row_order BIGSERIAL UNIQUE, bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS world_identities (__row_order BIGSERIAL UNIQUE, subject_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS world_verifications (__row_order BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE, digest TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, token_id_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS world_verification_for_proposal ON world_verifications(proposal_id,user_id,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_operation_per_owner ON operations(user_id) WHERE state IN ('prepared','submitted');
CREATE INDEX IF NOT EXISTS intents_by_user ON intents(user_id);
CREATE INDEX IF NOT EXISTS audit_by_user ON audit(user_id,created_at);
CREATE INDEX IF NOT EXISTS messages_by_room ON messages(room_id,created_at);
CREATE INDEX IF NOT EXISTS proposals_by_left ON proposals(left_user);
CREATE INDEX IF NOT EXISTS proposals_by_right ON proposals(right_user);

CREATE TABLE IF NOT EXISTS wallet_auth_challenges (__row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  message TEXT NOT NULL,
  flow_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))
);
CREATE INDEX IF NOT EXISTS wallet_auth_expiry ON wallet_auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS user_preferences (__row_order BIGSERIAL UNIQUE,
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tour_completed INTEGER NOT NULL DEFAULT 0 CHECK(tour_completed IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (__row_order BIGSERIAL UNIQUE,
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

CREATE TABLE IF NOT EXISTS private_context_documents (__row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 1048576),
  metadata TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_context_by_owner ON private_context_documents(user_id,id);
CREATE TABLE IF NOT EXISTS private_context_shares (__row_order BIGSERIAL UNIQUE,
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

CREATE TABLE IF NOT EXISTS policy_history (__row_order BIGSERIAL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,version)
);

CREATE TABLE IF NOT EXISTS qualifications (__row_order BIGSERIAL UNIQUE,
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
CREATE TABLE IF NOT EXISTS profile_intakes (__row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_plans (__row_order BIGSERIAL UNIQUE,
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_jobs (__row_order BIGSERIAL UNIQUE,
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
CREATE TABLE IF NOT EXISTS discovery_preferences (__row_order BIGSERIAL UNIQUE,
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_registrations (__row_order BIGSERIAL UNIQUE,
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS namespace_claims (__row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (__row_order BIGSERIAL UNIQUE,
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

CREATE TABLE IF NOT EXISTS inference_budgets (__row_order BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  config_digest TEXT NOT NULL,
  max_requests BIGINT NOT NULL CHECK(max_requests >= 0),
  max_cost_nusd BIGINT NOT NULL CHECK(max_cost_nusd >= 0),
  used_requests BIGINT NOT NULL DEFAULT 0 CHECK(used_requests >= 0),
  charged_nusd BIGINT NOT NULL DEFAULT 0 CHECK(charged_nusd >= 0),
  state TEXT NOT NULL CHECK(state IN ('active','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inference_attempts (__row_order BIGSERIAL UNIQUE,
  request_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES inference_budgets(id),
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  reserved_nusd BIGINT NOT NULL CHECK(reserved_nusd >= 0),
  charged_nusd BIGINT NOT NULL CHECK(charged_nusd >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','overrun')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS inference_attempts_by_budget ON inference_attempts(budget_id,created_at,request_id);

REVOKE ALL ON ALL TABLES IN SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA meeti_private REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA meeti_private REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA meeti_private TO meeti_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA meeti_private TO meeti_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA meeti_private TO meeti_runtime;
ALTER TABLE meeti_private.agent_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.agent_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.agent_registrations TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.agent_runs TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.agent_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.agent_tasks TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.agents FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.agents TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.audit FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.audit TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.blocks TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.challenges TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.consents FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.consents TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.discovery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.discovery_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.discovery_jobs TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.discovery_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.discovery_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.discovery_preferences TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.inference_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.inference_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.inference_attempts TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.inference_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.inference_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.inference_budgets TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.intents FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.intents TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.meeting_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.meeting_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.meeting_plans TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.messages TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.namespace_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.namespace_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.namespace_claims TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.operations FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.operations TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.policy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.policy_history FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.policy_history TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.private_context_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.private_context_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.private_context_documents TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.private_context_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.private_context_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.private_context_shares TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.profile_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.profile_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.profile_intakes TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.proposals TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.qualifications TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.rate_limits TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.rooms TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.sessions TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.user_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.user_preferences TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.users FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.users TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.wallet_auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.wallet_auth_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.wallet_auth_challenges TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.world_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.world_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.world_identities TO meeti_runtime USING (true) WITH CHECK (true);
ALTER TABLE meeti_private.world_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeti_private.world_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY server_access ON meeti_private.world_verifications TO meeti_runtime USING (true) WITH CHECK (true);
