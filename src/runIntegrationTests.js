import { spawn } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;

const developmentDatabaseUrl =
  process.env.DATABASE_URL ||
  'postgres://shoot_email:shoot_email@localhost:5432/shoot_email';
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL || deriveTestDatabaseUrl(developmentDatabaseUrl);

const testDatabaseName = new URL(testDatabaseUrl).pathname.slice(1);

if (!testDatabaseName.endsWith('_test')) {
  throw new Error(
    `TEST_DATABASE_URL must use a database ending in "_test"; received "${testDatabaseName}".`,
  );
}

await ensureDatabaseExists(testDatabaseUrl);

const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    'test/integration.test.js',
    'test/cliContract.test.js',
    'test/mcp.test.js',
  ],
  {
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
    },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

function deriveTestDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.slice(1) || 'shoot_email';
  url.pathname = `/${databaseName}_test`;
  return url.toString();
}

async function ensureDatabaseExists(databaseUrl) {
  const targetUrl = new URL(databaseUrl);
  const databaseName = targetUrl.pathname.slice(1);
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = '/postgres';

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();

  try {
    const existing = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    );

    if (existing.rowCount === 0) {
      const quotedName = `"${databaseName.replaceAll('"', '""')}"`;
      await client.query(`CREATE DATABASE ${quotedName}`);
      console.log(`Created integration test database ${databaseName}.`);
    }
  } finally {
    await client.end();
  }
}
