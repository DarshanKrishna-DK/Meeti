CREATE TABLE IF NOT EXISTS inference_budgets (
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
CREATE TABLE IF NOT EXISTS inference_attempts (
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
