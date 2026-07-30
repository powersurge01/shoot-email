#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const recoveryDatabaseUrl = process.env.RECOVERY_DATABASE_URL;
const productionDatabaseUrl = process.env.PRODUCTION_DATABASE_URL;

if (!recoveryDatabaseUrl) {
  throw new Error('RECOVERY_DATABASE_URL is required.');
}
if (!productionDatabaseUrl) {
  throw new Error('PRODUCTION_DATABASE_URL is required as a recovery safety reference.');
}
if (sameDatabaseTarget(recoveryDatabaseUrl, productionDatabaseUrl)) {
  throw new Error('Recovery verification refuses to use the production connection string.');
}

const client = new Client({ connectionString: recoveryDatabaseUrl });
await client.connect();

try {
  const migrationFiles = (await fs.readdir(
    path.resolve(import.meta.dirname, '..', 'sql'),
  ))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations = await client.query(
    'SELECT filename FROM schema_migrations ORDER BY filename',
  );
  const appliedFiles = migrations.rows.map((row) => row.filename);
  const missingMigrations = migrationFiles.filter(
    (file) => !appliedFiles.includes(file),
  );
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `,
  );
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  const requiredTables = [
    'messages',
    'schema_migrations',
    'service_runtime_controls',
    'user_identities',
    'users',
  ];
  const missingTables = requiredTables.filter((table) => !tableNames.has(table));
  const controls = await client.query(
    'SELECT count(*)::int AS count FROM service_runtime_controls',
  );
  const counts = await client.query(
    `
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM messages) AS messages,
        (SELECT count(*)::int FROM user_identities) AS identities
    `,
  );
  const ok = (
    missingMigrations.length === 0
    && missingTables.length === 0
    && controls.rows[0].count === 1
  );

  console.log(JSON.stringify({
    ok,
    verifiedAt: new Date().toISOString(),
    database: 'recovery-target',
    migrations: {
      expected: migrationFiles.length,
      applied: appliedFiles.length,
      missing: missingMigrations,
    },
    missingTables,
    runtimeControlRows: controls.rows[0].count,
    rowCounts: counts.rows[0],
  }, null, 2));
  if (!ok) process.exitCode = 2;
} finally {
  await client.end();
}

function sameDatabaseTarget(left, right) {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  return (
    leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase()
    && normalizedPort(leftUrl) === normalizedPort(rightUrl)
    && leftUrl.pathname === rightUrl.pathname
    && decodeURIComponent(leftUrl.username) === decodeURIComponent(rightUrl.username)
  );
}

function normalizedPort(url) {
  return url.port || '5432';
}
