import pg from 'pg';

const { Client } = pg;

export function createRequestDatabase(connectionString) {
  if (!connectionString) {
    throw new Error('A Hyperdrive connection string is required.');
  }

  let client;
  let connecting;
  let inTransaction = false;

  async function getClient() {
    if (!client) {
      client = new Client({ connectionString });
      connecting = client.connect();
    }
    await connecting;
    return client;
  }

  return {
    async query(text, params) {
      return (await getClient()).query(text, params);
    },

    async transaction(callback) {
      if (inTransaction) {
        throw new Error('Nested database transactions are not supported.');
      }

      const transactionClient = await getClient();
      inTransaction = true;
      try {
        await transactionClient.query('BEGIN');
        const result = await callback(
          (text, params) => transactionClient.query(text, params),
        );
        await transactionClient.query('COMMIT');
        return result;
      } catch (error) {
        await transactionClient.query('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },

    async close() {
      if (!client) return;
      try {
        await connecting;
      } finally {
        await client.end();
        client = undefined;
        connecting = undefined;
      }
    },
  };
}
