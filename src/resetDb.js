import { closePool, query } from './db.js';
import { migrate } from './migrate.js';

export async function resetDatabase({ force = false } = {}) {
  if (!force && process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing to reset the database without --yes or NODE_ENV=test.');
  }

  const databaseResult = await query('SELECT current_database() AS name');
  const databaseName = databaseResult.rows[0].name;

  if (process.env.NODE_ENV === 'test' && !databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to reset non-test database "${databaseName}" while NODE_ENV=test.`,
    );
  }

  await query('DROP SCHEMA IF EXISTS public CASCADE');
  await query('CREATE SCHEMA public');
  await query('GRANT ALL ON SCHEMA public TO public');
  await migrate();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--yes');

  try {
    await resetDatabase({ force });
    console.log('Database reset complete.');
  } finally {
    await closePool();
  }
}
