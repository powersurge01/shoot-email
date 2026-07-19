import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBackendRequest } from '../workers/backend/src/index.js';

const demoEnv = {
  ENABLE_REMOTE_MCP_DEMO: 'true',
  REMOTE_MCP_DEMO_TOKEN: 'demo-secret',
  REMOTE_MCP_DEMO_SUBJECT: 'server-controlled-demo-subject',
  REMOTE_MCP_DEMO_SESSION: 'server-controlled-demo-session',
};

test('remote MCP route is hidden when the demo is disabled', async () => {
  const response = await handleBackendRequest(mcpRequest(initializeRequest()), {}, {});
  assert.equal(response.status, 404);
});

test('remote MCP route fails closed when its principal is not configured', async () => {
  const response = await handleBackendRequest(
    mcpRequest(initializeRequest(), 'demo-secret.judge001'),
    { ENABLE_REMOTE_MCP_DEMO: 'true' },
    {},
  );
  assert.equal(response.status, 503);
});

test('remote MCP route rejects missing and invalid bearer tokens before database access', async () => {
  for (const token of [undefined, 'wrong-secret.judge001', 'demo-secret.short']) {
    const response = await handleBackendRequest(
      mcpRequest(initializeRequest(), token),
      demoEnv,
      {},
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Bearer /);
  }
});

test('remote MCP route serves stateless MCP discovery with a valid bearer token', async () => {
  const initialized = await handleBackendRequest(
    mcpRequest(initializeRequest(), 'demo-secret.judge001'),
    demoEnv,
    { database: fakeDatabase() },
  );
  assert.equal(initialized.status, 200);
  const initializeBody = await initialized.json();
  assert.equal(initializeBody.result.serverInfo.name, 'shoot-email');
  assert.equal(initializeBody.result.capabilities.tools.listChanged, true);

  const listed = await handleBackendRequest(
    mcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      'demo-secret.judge001',
    ),
    demoEnv,
    { database: fakeDatabase() },
  );
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.equal(listBody.result.tools.length, 10);
  assert.equal(
    listBody.result.tools.every((tool) => tool.outputSchema?.type === 'object'),
    true,
  );
});

test('remote MCP route explicitly declines standalone SSE in stateless mode', async () => {
  const response = await handleBackendRequest(
    new Request('https://backend.example/mcp', {
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer demo-secret.judge001',
      },
    }),
    demoEnv,
    {},
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('remote MCP route rejects malformed JSON with a bounded client error', async () => {
  const response = await handleBackendRequest(
    new Request('https://backend.example/mcp', {
      method: 'POST',
      headers: mcpHeaders('demo-secret.judge001'),
      body: '{invalid',
    }),
    demoEnv,
    { database: fakeDatabase() },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'MCP request body must be valid JSON.',
  });
});

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shoot-email-test', version: '1.0.0' },
    },
  };
}

function mcpRequest(body, token) {
  return new Request('https://backend.example/mcp', {
    method: 'POST',
    headers: mcpHeaders(token),
    body: JSON.stringify(body),
  });
}

function mcpHeaders(token) {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function fakeDatabase() {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async transaction(callback) {
      return callback((text, params) => this.query(text, params));
    },
  };
}
