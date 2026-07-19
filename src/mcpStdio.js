#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closePool } from './db.js';
import { createShootEmailMcpServer } from './mcpServer.js';

const server = createShootEmailMcpServer();
const transport = new StdioServerTransport();

const shutdown = async () => {
  await server.close();
  await closePool();
};

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

try {
  await server.connect(transport);
} catch (error) {
  console.error(error);
  await closePool();
  process.exitCode = 1;
}
