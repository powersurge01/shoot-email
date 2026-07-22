import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createShootEmailMcpServer } from './mcpServer.js';

const MAX_MCP_BODY_BYTES = 1_000_000;
const OAUTH_SCOPES = ['mailbox:read', 'mailbox:send', 'mailbox:acknowledge'];
const jwksByUrl = new Map();

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

export async function authorizeRemoteMcpOAuth(request, env, options = {}) {
  if (env.ENABLE_REMOTE_MCP_OAUTH !== 'true') {
    return { enabled: false, authorized: false };
  }

  const issuer = normalizeIssuer(env.AUTH0_ISSUER);
  const audience = env.AUTH0_AUDIENCE?.trim();
  if (!issuer || !audience) {
    return { enabled: true, configured: false, authorized: false };
  }

  const token = readBearerToken(request.headers.get('authorization'));
  if (!token) {
    return { enabled: true, configured: true, authorized: false };
  }

  try {
    const jwksUrl = new URL('.well-known/jwks.json', issuer);
    let jwks = options.jwks || jwksByUrl.get(jwksUrl.href);
    if (!jwks) {
      jwks = createRemoteJWKSet(jwksUrl);
      jwksByUrl.set(jwksUrl.href, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return { enabled: true, configured: true, authorized: false };
    }

    const scopes = readTokenScopes(payload);
    return {
      enabled: true,
      configured: true,
      authorized: true,
      scopes,
      principal: {
        provider: `auth0:${new URL(issuer).host}`,
        subject: payload.sub,
        session: null,
        organization: typeof payload.org_id === 'string' ? payload.org_id : null,
        authentication: 'auth0_oauth',
        demo: false,
      },
      authInfo: {
        token: 'redacted',
        clientId: readClientId(payload),
        scopes,
      },
    };
  } catch {
    return { enabled: true, configured: true, authorized: false };
  }
}

export async function handleRemoteMcpRequest(request, authorization) {
  const parsedBody = await readMcpBody(request);
  const missingScope = findMissingScope(parsedBody, authorization.scopes);
  if (missingScope) {
    return remoteMcpForbiddenResponse(request, missingScope);
  }

  const server = createShootEmailMcpServer({ principal: authorization.principal });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      parsedBody,
      authInfo: authorization.authInfo,
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

export function oauthProtectedResourceMetadata(request, env) {
  const issuer = normalizeIssuer(env.AUTH0_ISSUER);
  const resource = env.AUTH0_AUDIENCE?.trim();
  if (!issuer || !resource) return null;

  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

export function remoteMcpOAuthUnauthorizedResponse(request, error = 'invalid_token') {
  const metadataUrl = new URL('/.well-known/oauth-protected-resource', request.url).href;
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'OAuth access token is missing or invalid.' },
    id: null,
  }, {
    status: 401,
    headers: {
      'WWW-Authenticate': [
        'Bearer',
        `resource_metadata="${metadataUrl}"`,
        `scope="${OAUTH_SCOPES.join(' ')}"`,
        `error="${error}"`,
      ].join(', '),
    },
  });
}

export function remoteMcpForbiddenResponse(request, requiredScope) {
  const metadataUrl = new URL('/.well-known/oauth-protected-resource', request.url).href;
  return Response.json({
    jsonrpc: '2.0',
    error: {
      code: -32003,
      message: `Insufficient scope. Required: ${requiredScope}.`,
      data: { requiredScope },
    },
    id: null,
  }, {
    status: 403,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="${requiredScope}"`,
    },
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

function normalizeIssuer(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function readTokenScopes(payload) {
  const values = [];
  if (typeof payload.scope === 'string') values.push(...payload.scope.split(/\s+/));
  if (Array.isArray(payload.permissions)) values.push(...payload.permissions);
  return [...new Set(values.filter((scope) => typeof scope === 'string' && scope))];
}

function readClientId(payload) {
  if (typeof payload.client_id === 'string') return payload.client_id;
  if (typeof payload.azp === 'string') return payload.azp;
  return 'unknown-oauth-client';
}

function findMissingScope(body, scopes = []) {
  const available = new Set(scopes);
  const required = new Set(['mailbox:read']);
  const requests = Array.isArray(body) ? body : [body];
  for (const entry of requests) {
    if (entry?.method !== 'tools/call') continue;
    if (entry.params?.name === 'send_text_email') required.add('mailbox:send');
    if (entry.params?.name === 'acknowledge_messages') {
      required.add('mailbox:acknowledge');
    }
  }
  return [...required].find((scope) => !available.has(scope)) || null;
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
