import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const files = ['001_initial.sql', '002_onboarding.sql', '003_agent_runs.sql', '004_context.sql', '005_policy_history.sql', '006_networking_flow.sql', '007_namespace_claims.sql', '008_agent_tasks.sql', '009_inference_budget.sql', '010_auto_qualification.sql'];
const source = files.map(file => readFileSync(`migrations/${file}`, 'utf8')).join('\n');
const local = new DatabaseSync(':memory:');
local.exec(source);
const tables = local.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const columns = Object.fromEntries(tables.map(({ name }) => [name, local.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name)]));
local.close();
mkdirSync('migrations/postgres', { recursive: true });
const sql = source.replace(/^PRAGMA[^;]*;\s*/gm, '')
  .replace(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g, 'CREATE TABLE IF NOT EXISTS $1 (__row_order BIGSERIAL UNIQUE, ')
  .replace(/reset_at INTEGER/g, 'reset_at BIGINT').replace(/[ \t]+$/gm, '');
const policies = tables.map(({ name }) => `ALTER TABLE meeti_private.${name} ENABLE ROW LEVEL SECURITY;\nALTER TABLE meeti_private.${name} FORCE ROW LEVEL SECURITY;\nCREATE POLICY server_access ON meeti_private.${name} TO meeti_runtime USING (true) WITH CHECK (true);`).join('\n');
writeFileSync('migrations/postgres/001_meeti.sql', `-- Private server persistence. Existing encrypted payloads and AAD identifiers are preserved.
-- The dedicated backend role has DML access. Opaque wallet sessions enforce tenant ownership in the backend.
-- No browser role receives access, and these tables are outside the exposed public schema.
CREATE ROLE meeti_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 8;
CREATE SCHEMA meeti_private;
REVOKE ALL ON SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
SET search_path TO meeti_private, pg_catalog;
${sql}
REVOKE ALL ON ALL TABLES IN SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA meeti_private FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA meeti_private REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA meeti_private REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA meeti_private TO meeti_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA meeti_private TO meeti_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA meeti_private TO meeti_runtime;
${policies}
`);
writeFileSync('packages/server/store-columns.ts', `// Generated from the authoritative SQLite migrations. Hidden ordering columns are excluded.\nexport const storeColumns: Record<string, readonly string[]> = ${JSON.stringify(columns, null, 2)};\n`);
console.log(`Generated private Postgres schema and explicit insert columns for ${tables.length} tables.`);
