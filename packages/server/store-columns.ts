// Generated from the authoritative SQLite migrations. Hidden ordering columns are excluded.
export const storeColumns: Record<string, readonly string[]> = {
  "agent_registrations": [
    "user_id",
    "data",
    "updated_at"
  ],
  "agent_runs": [
    "id",
    "user_id",
    "kind",
    "status",
    "stage",
    "started_at",
    "updated_at",
    "expires_at",
    "proposal_id"
  ],
  "agent_tasks": [
    "id",
    "user_id",
    "kind",
    "status",
    "input_digest",
    "data",
    "lease_token",
    "created_at",
    "updated_at",
    "expires_at"
  ],
  "agents": [
    "id",
    "user_id",
    "data"
  ],
  "audit": [
    "id",
    "user_id",
    "action",
    "outcome",
    "detail",
    "created_at"
  ],
  "blocks": [
    "user_id",
    "blocked_id"
  ],
  "challenges": [
    "id",
    "user_id",
    "kind",
    "binding",
    "data",
    "expires_at",
    "used"
  ],
  "consents": [
    "id",
    "proposal_id",
    "user_id",
    "decision",
    "digest",
    "signature",
    "created_at"
  ],
  "discovery_jobs": [
    "intent_id",
    "user_id",
    "binding",
    "enabled",
    "next_run_at",
    "lease_token",
    "lease_until",
    "result",
    "checked_at",
    "failure_code",
    "failures"
  ],
  "discovery_preferences": [
    "user_id",
    "enabled"
  ],
  "inference_attempts": [
    "request_id",
    "budget_id",
    "task",
    "model",
    "reserved_nusd",
    "charged_nusd",
    "state",
    "created_at",
    "settled_at"
  ],
  "inference_budgets": [
    "id",
    "model",
    "config_digest",
    "max_requests",
    "max_cost_nusd",
    "used_requests",
    "charged_nusd",
    "state",
    "created_at",
    "updated_at"
  ],
  "intents": [
    "id",
    "user_id",
    "version",
    "status",
    "data"
  ],
  "meeting_plans": [
    "proposal_id",
    "version",
    "data",
    "updated_at"
  ],
  "messages": [
    "id",
    "room_id",
    "user_id",
    "body",
    "created_at"
  ],
  "namespace_claims": [
    "id",
    "user_id",
    "label",
    "recipient",
    "version",
    "state",
    "data",
    "created_at",
    "updated_at"
  ],
  "operations": [
    "id",
    "user_id",
    "kind",
    "state",
    "data",
    "created_at"
  ],
  "policy_history": [
    "user_id",
    "version",
    "data",
    "created_at"
  ],
  "private_context_documents": [
    "id",
    "user_id",
    "version",
    "size",
    "metadata",
    "content"
  ],
  "private_context_shares": [
    "id",
    "document_id",
    "user_id",
    "recipient_id",
    "proposal_id",
    "version",
    "expires_at",
    "data"
  ],
  "profile_intakes": [
    "id",
    "user_id",
    "version",
    "data",
    "updated_at"
  ],
  "proposals": [
    "id",
    "left_user",
    "right_user",
    "pair_key",
    "status",
    "digest",
    "data"
  ],
  "qualifications": [
    "id",
    "left_user",
    "right_user",
    "pair_key",
    "state",
    "version",
    "data",
    "lease_token",
    "lease_until",
    "updated_at"
  ],
  "rate_limits": [
    "bucket",
    "count",
    "reset_at"
  ],
  "rooms": [
    "id",
    "proposal_id",
    "data"
  ],
  "sessions": [
    "token_hash",
    "user_id",
    "expires_at"
  ],
  "user_preferences": [
    "user_id",
    "tour_completed",
    "updated_at"
  ],
  "users": [
    "id",
    "email",
    "password_hash",
    "wallet",
    "profile",
    "created_at"
  ],
  "wallet_auth_challenges": [
    "id",
    "address",
    "chain_id",
    "origin",
    "message",
    "flow_hash",
    "expires_at",
    "used"
  ],
  "world_identities": [
    "subject_hash",
    "user_id"
  ],
  "world_verifications": [
    "id",
    "user_id",
    "proposal_id",
    "digest",
    "token_digest",
    "token_id_hash",
    "data",
    "expires_at"
  ]
};
