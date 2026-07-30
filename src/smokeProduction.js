const baseUrl = process.env.PRODUCTION_BACKEND_URL
  || 'https://mcp.shoot-email.yoyowza.com';
const expectedResource = process.env.PRODUCTION_MCP_RESOURCE
  || `${baseUrl.replace(/\/+$/, '')}/mcp`;
const timeoutMs = Number(process.env.PRODUCTION_SMOKE_TIMEOUT_MS || 10_000);

const health = await getJson('/health');
assert(
  health.response.status === 200
    && health.body.ok === true
    && health.body.environment === 'production',
  'Production health check failed.',
);

const ready = await getJson('/ready');
assert(
  ready.response.status === 200
    && ready.body.ok === true
    && ready.body.database === 'ready',
  'Production database readiness check failed.',
);

const metadata = await getJson('/.well-known/oauth-protected-resource');
assert(
  metadata.response.status === 200
    && metadata.body.resource === expectedResource
    && Array.isArray(metadata.body.authorization_servers)
    && metadata.body.authorization_servers.length === 1,
  'OAuth protected-resource metadata is invalid.',
);

const unauthorized = await fetch(new URL('/mcp', baseUrl), {
  method: 'POST',
  headers: {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shoot-email-production-smoke', version: '1.0.0' },
    },
  }),
  signal: AbortSignal.timeout(timeoutMs),
});
assert(unauthorized.status === 401, 'Unauthenticated MCP request was not rejected.');
assert(
  unauthorized.headers.get('www-authenticate')?.includes('resource_metadata='),
  'OAuth challenge did not advertise protected-resource metadata.',
);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  environment: health.body.environment,
  database: ready.body.database,
  resource: metadata.body.resource,
  authorizationServer: metadata.body.authorization_servers[0],
  unauthenticatedMcpStatus: unauthorized.status,
  latencyMs: {
    health: health.latencyMs,
    readiness: ready.latencyMs,
    metadata: metadata.latencyMs,
  },
}, null, 2));

async function getJson(pathname) {
  const startedAt = performance.now();
  const response = await fetch(new URL(pathname, baseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return {
    response,
    body,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
