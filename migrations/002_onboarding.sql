CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
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
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tour_completed INTEGER NOT NULL DEFAULT 0 CHECK(tour_completed IN (0,1)),
  updated_at TEXT NOT NULL
);
