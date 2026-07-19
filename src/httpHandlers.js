import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { query } from './db.js';
import {
  normalizeOpenAiAppsContext,
  serializeOpenAiContext,
} from './openAiAppsContext.js';
import { normalizeInboundPayload } from './inboundEmail.js';
import { findOrCreateOpenAiContext, ingestInboundMessage } from './services.js';

export function getHealthResponse(environment) {
  const config = getConfig();
  return {
    status: 200,
    body: {
      ok: true,
      service: 'shoot-email',
      environment: environment || config.environment,
    },
  };
}

export async function getReadinessResponse() {
  try {
    await query('SELECT 1');
    return {
      status: 200,
      body: { ok: true, database: 'ready' },
    };
  } catch (error) {
    console.error('Database readiness check failed.', error);
    return {
      status: 503,
      body: {
        ok: false,
        database: 'unavailable',
        error: 'Database connection failed.',
      },
    };
  }
}

export async function handleInboundWebhook({ authorization, body, token }) {
  const authentication = authorizeInboundWebhook(authorization, token);

  if (!authentication.configured) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'Inbound webhook authentication is not configured.',
      },
    };
  }

  if (!authentication.authorized) {
    return {
      status: 401,
      body: { ok: false, error: 'Unauthorized inbound webhook.' },
    };
  }

  const normalized = normalizeInboundPayload(body);
  const result = await ingestInboundMessage(normalized);

  return {
    status: 200,
    body: {
      ok: true,
      stored: result.stored,
      reason: result.reason,
      messageId: result.message?.id,
    },
  };
}

export async function handleOpenAiContext(body) {
  const context = normalizeOpenAiAppsContext(body);

  if (!context.subject) {
    return {
      status: 400,
      body: {
        ok: false,
        error: '_meta["openai/subject"] is required.',
      },
    };
  }

  const result = await findOrCreateOpenAiContext(context);
  return {
    status: 200,
    body: {
      ok: true,
      ...serializeOpenAiContext(result),
    },
  };
}

function authorizeInboundWebhook(authorization, configuredToken) {
  const token = configuredToken ?? getConfig().inboundWebhookToken;

  if (!token) {
    return { configured: false, authorized: false };
  }

  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(authorization || '');

  return {
    configured: true,
    authorized:
      expected.length === provided.length
      && crypto.timingSafeEqual(expected, provided),
  };
}
