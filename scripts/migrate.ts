import { db as sqlite } from '../packages/server/db';
import { db, closeStore } from '../packages/server/store';
import { storeColumns } from '../packages/server/store-columns';
if (process.env.DATABASE_PROVIDER === 'postgres') {
  try {
    // The runtime role cannot apply DDL. Apply the reviewed SQL with a database administrator first.
    for (const [table, columns] of Object.entries(storeColumns)) await db().prepare(`SELECT ${columns.join(',')} FROM ${table} LIMIT 0`).all();
    console.log(`Private Postgres schema verified: ${Object.keys(storeColumns).length} tables. No DDL was executed.`);
  } finally { await closeStore(); }
} else { sqlite(); console.log('SQLite schema is current.'); }
