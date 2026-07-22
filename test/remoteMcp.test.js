import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import {
  authorizeRemoteMcpOAuth,
  handleRemoteMcpRequest,
} from '../src/remoteMcp.js';
import { handleBackendRequest } from '../workers/backend/src/index.js';

const demoEnv = {
  ENABLE_REMOTE_MCP_DEMO: 'true',
  REMOTE_MCP_DEMO_TOKEN: 'demo-secret',
  REMOTE_MCP_DEMO_SUBJECT: 'server-controlled-demo-subject',
  REMOTE_MCP_DEMO_SESSION: 'server-controlled-demo-session',
};

const oauthEnv = {
  ENABLE_REMOTE_MCP_OAUTH: 'true',
  AUTH0_ISSUER: 'https://tenant.example.auth0.com/',
  AUTH0_AUDIENCE: 'https://oauth-backend.example/mcp',
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

test('OAuth deployment publishes protected resource metadata without database access', async () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const response = await handleBackendRequest(
      new Request(`https://oauth-backend.example${path}`),
      oauthEnv,
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: oauthEnv.AUTH0_AUDIENCE,
      authorization_servers: [oauthEnv.AUTH0_ISSUER],
      scopes_supported: ['mailbox:read', 'mailbox:send', 'mailbox:acknowledge'],
      bearer_methods_supported: ['header'],
    });
  }
});

test('OAuth deployment challenges missing tokens before database access', async () => {
  const response = await handleBackendRequest(
    mcpRequest(initializeRequest()),
    oauthEnv,
    {},
  );
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get('www-authenticate'),
    /resource_metadata="https:\/\/backend\.example\/\.well-known\/oauth-protected-resource"/,
  );
});

test('Auth0 JWT validation derives a trusted principal and scopes', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'oauth-test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({
    scope: 'mailbox:read mailbox:send',
    client_id: 'test-client',
    org_id: 'org_test',
  })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(oauthEnv.AUTH0_ISSUER)
    .setAudience(oauthEnv.AUTH0_AUDIENCE)
    .setSubject('auth0|user-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  const result = await authorizeRemoteMcpOAuth(
    mcpRequest(initializeRequest(), token),
    oauthEnv,
    { jwks },
  );
  assert.equal(result.authorized, true);
  assert.deepEqual(result.scopes, ['mailbox:read', 'mailbox:send']);
  assert.deepEqual(result.principal, {
    provider: 'auth0:tenant.example.auth0.com',
    subject: 'auth0|user-123',
    session: null,
    organization: 'org_test',
    authentication: 'auth0_oauth',
    demo: false,
  });
  assert.deepEqual(result.authInfo, {
    token: 'redacted',
    clientId: 'test-client',
    scopes: ['mailbox:read', 'mailbox:send'],
  });
});

test('OAuth scope checks reject send and acknowledgement before tool execution', async () => {
  for (const [name, requiredScope] of [
    ['send_text_email', 'mailbox:send'],
    ['acknowledge_messages', 'mailbox:acknowledge'],
  ]) {
    const response = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: {} },
      }),
      {
        principal: { provider: 'auth0:test', subject: 'subject-1' },
        scopes: ['mailbox:read'],
        authInfo: { token: 'redacted', clientId: 'test', scopes: ['mailbox:read'] },
      },
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.data.requiredScope, requiredScope);
    assert.match(response.headers.get('www-authenticate'), /insufficient_scope/);
  }
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
