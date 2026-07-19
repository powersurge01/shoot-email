import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '..', 'sql');

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const alreadyApplied = await query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file],
    );

    if (alreadyApplied.rowCount > 0) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await query('BEGIN');
    try {
      await query(sql);
      await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
        file,
      ]);
      await query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await migrate();
  } finally {
    await closePool();
  }
}
