#!/usr/bin/env node
import { closePool } from './db.js';
import { getOperationsReport } from './services.js';

process.env.SHOOT_EMAIL_ENV ||= 'production';

const baseUrl = process.env.PRODUCTION_BACKEND_URL
  || 'https://mcp.shoot-email.yoyowza.com';
const minimumActiveUsers = readPositiveInteger('BETA_MIN_ACTIVE_USERS', 3);
const maximumActiveUsers = readPositiveInteger('BETA_MAX_ACTIVE_USERS', 5);
const timeoutMs = readPositiveInteger('BETA_READINESS_TIMEOUT_MS', 10_000);

try {
  const [operations, health, readiness, metadata] = await Promise.all([
    getOperationsReport(),
    getJson('/health'),
    getJson('/ready'),
    getJson('/.well-known/oauth-protected-resource'),
  ]);
  const checks = {
    productionHealth:
      health.response.ok
      && health.body.ok === true
      && health.body.environment === 'production',
    databaseReadiness:
      readiness.response.ok
      && readiness.body.ok === true
      && readiness.body.database === 'ready',
    oauthMetadata:
      metadata.response.ok
      && metadata.body.resource === `${baseUrl.replace(/\/+$/, '')}/mcp`,
    productionConfiguration: operations.environment === 'production',
    outboundRuntimeEnabled: operations.controls.effectiveOutboundEnabled === true,
    activeCohortMinimum: operations.beta.active >= minimumActiveUsers,
    activeCohortMaximum: operations.beta.active <= maximumActiveUsers,
    googleBrandingApproved:
      process.env.BETA_GOOGLE_BRANDING_APPROVED === 'true',
    auth0DcrAuditHealthy:
      process.env.BETA_AUTH0_DCR_AUDIT_OK === 'true',
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
  const result = {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    environment: operations.environment,
    checks,
    blockers,
    cohort: {
      minimumActiveUsers,
      maximumActiveUsers,
      ...operations.beta,
    },
    users: operations.users,
    controls: operations.controls,
    publicLatencyMs: {
      health: health.latencyMs,
      readiness: readiness.latencyMs,
      metadata: metadata.latencyMs,
    },
    requiredAttestations: {
      BETA_GOOGLE_BRANDING_APPROVED:
        'Set true only after Google reports branding verification approved.',
      BETA_AUTH0_DCR_AUDIT_OK:
        'Set true only after the current Auth0 DCR audit is below its warning threshold.',
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
} finally {
  await closePool();
}

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

function readPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
