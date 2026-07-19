import { runWithDatabase } from '../../../src/db.js';
import { createRequestDatabase } from '../../../src/hyperdriveDb.js';
import {
  getHealthResponse,
  getReadinessResponse,
  handleInboundWebhook,
  handleOpenAiContext,
} from '../../../src/httpHandlers.js';

const MAX_JSON_BODY_BYTES = 1_000_000;

export default {
  fetch(request, env) {
    return handleBackendRequest(request, env);
  },
};

export async function handleBackendRequest(request, env, options = {}) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse(getHealthResponse(env.SHOOT_EMAIL_ENV));
  }

  if (!isDatabaseRoute(request.method, url.pathname)) {
    return jsonResponse({
      status: 404,
      body: { ok: false, error: 'Not found.' },
    });
  }

  if (!env.HYPERDRIVE?.connectionString && !options.database) {
    return jsonResponse({
      status: 503,
      body: { ok: false, error: 'Hyperdrive is not configured.' },
    });
  }

  const database = options.database
    || createRequestDatabase(env.HYPERDRIVE.connectionString);

  try {
    return await runWithDatabase(database, async () => {
      if (request.method === 'GET' && url.pathname === '/ready') {
        return jsonResponse(await getReadinessResponse());
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/email/inbound') {
        const body = await readJsonBody(request);
        return jsonResponse(await handleInboundWebhook({
          authorization: request.headers.get('authorization'),
          body,
          token: env.INBOUND_WEBHOOK_TOKEN,
        }));
      }

      if (request.method === 'POST' && url.pathname === '/apps/openai/context') {
        if (env.ENABLE_UNAUTHENTICATED_OPENAI_CONTEXT !== 'true') {
          return jsonResponse({
            status: 404,
            body: { ok: false, error: 'Not found.' },
          });
        }
        return jsonResponse(await handleOpenAiContext(await readJsonBody(request)));
      }

      return jsonResponse({
        status: 404,
        body: { ok: false, error: 'Not found.' },
      });
    });
  } catch (error) {
    const status = error.code === 'invalid_json_body' ? 400 : 500;
    if (status === 500) {
      console.error('Backend Worker request failed.', error);
    }
    return jsonResponse({
      status,
      body: {
        ok: false,
        error: status === 400 ? error.message : 'Internal server error.',
      },
    });
  } finally {
    if (!options.database) {
      await database.close();
    }
  }
}

function isDatabaseRoute(method, pathname) {
  return (
    (method === 'GET' && pathname === '/ready')
    || (method === 'POST' && pathname === '/webhooks/email/inbound')
    || (method === 'POST' && pathname === '/apps/openai/context')
  );
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw requestError('Request body exceeds 1 MB.');
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw requestError('Request body exceeds 1 MB.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw requestError('Request body must be valid JSON.');
  }
}

function requestError(message) {
  const error = new Error(message);
  error.code = 'invalid_json_body';
  return error;
}

function jsonResponse(result) {
  return Response.json(result.body, { status: result.status });
}
