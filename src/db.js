import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig } from './config.js';

const { Pool } = pg;

let pool;
const databaseContext = new AsyncLocalStorage();

export function runWithDatabase(database, callback) {
  return databaseContext.run(database, callback);
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConfig().databaseUrl,
    });
  }

  return pool;
}

export async function query(text, params) {
  const database = databaseContext.getStore();
  if (database) {
    return database.query(text, params);
  }
  return getPool().query(text, params);
}

export async function transaction(callback) {
  const database = databaseContext.getStore();
  if (database) {
    return database.transaction(callback);
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await callback((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
