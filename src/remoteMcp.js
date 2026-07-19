import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createShootEmailMcpServer } from './mcpServer.js';

const MAX_MCP_BODY_BYTES = 1_000_000;

export async function authorizeRemoteMcpDemo(request, env) {
  if (env.ENABLE_REMOTE_MCP_DEMO !== 'true') {
    return { enabled: false, authorized: false };
  }

  if (!env.REMOTE_MCP_DEMO_TOKEN || !env.REMOTE_MCP_DEMO_SUBJECT) {
    return { enabled: true, configured: false, authorized: false };
  }

  const provided = readBearerToken(request.headers.get('authorization'));
  const [providedSecret, clientKey, ...extraParts] = provided.split('.');
  const validClientKey = extraParts.length === 0
    && /^[A-Za-z0-9_-]{8,64}$/.test(clientKey || '');
  const authorized = validClientKey
    && constantTimeEqual(providedSecret, env.REMOTE_MCP_DEMO_TOKEN);
  return {
    enabled: true,
    configured: true,
    authorized,
    principal: {
      subject: authorized
        ? `${env.REMOTE_MCP_DEMO_SUBJECT}-${(await sha256(provided)).slice(0, 32)}`
        : env.REMOTE_MCP_DEMO_SUBJECT,
      session: env.REMOTE_MCP_DEMO_SESSION || null,
      organization: null,
      authentication: 'hackathon_demo_bearer',
      demo: true,
    },
  };
}

export async function handleRemoteMcpRequest(request, principal) {
  const parsedBody = await readMcpBody(request);
  const server = createShootEmailMcpServer({ principal });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      parsedBody,
      authInfo: {
        token: 'redacted',
        clientId: 'shoot-email-hackathon-demo',
        scopes: ['mailbox:demo'],
      },
    });
  } finally {
    await server.close();
  }
}

export function remoteMcpUnauthorizedResponse() {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized.' },
    id: null,
  }, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer realm="shoot-email-hackathon-demo"' },
  });
}

export function remoteMcpMisconfiguredResponse() {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32002, message: 'Remote MCP demo authentication is not configured.' },
    id: null,
  }, { status: 503 });
}

function readBearerToken(authorization) {
  if (typeof authorization !== 'string') return '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] || '';
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left || '');
  const rightBytes = new TextEncoder().encode(right || '');
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }

  return difference === 0;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function readMcpBody(request) {
  if (request.method !== 'POST') return undefined;

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_MCP_BODY_BYTES) {
    throw requestError('MCP request body exceeds 1 MB.');
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MCP_BODY_BYTES) {
    throw requestError('MCP request body exceeds 1 MB.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw requestError('MCP request body must be valid JSON.');
  }
}

function requestError(message) {
  const error = new Error(message);
  error.code = 'invalid_mcp_body';
  return error;
}
