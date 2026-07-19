import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBackendRequest } from '../workers/backend/src/index.js';

process.env.NODE_ENV = 'test';
process.env.MAIL_PROVIDER = 'mock';
process.env.INBOUND_DOMAIN = 'in.test';

test('backend Worker exposes liveness without a database binding', async () => {
  const response = await handleBackendRequest(
    new Request('https://backend.example/health'),
    { SHOOT_EMAIL_ENV: 'staging' },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'shoot-email',
    environment: 'staging',
  });
});

test('backend Worker readiness uses the request-scoped database', async () => {
  const queries = [];
  const response = await handleBackendRequest(
    new Request('https://backend.example/ready'),
    {},
    { database: fakeDatabase(queries) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, database: 'ready' });
  assert.deepEqual(queries, ['SELECT 1']);
});

test('backend Worker authenticates inbound webhook requests', async () => {
  const env = { INBOUND_WEBHOOK_TOKEN: 'test-secret' };
  const unauthorized = await handleBackendRequest(
    inboundRequest(),
    env,
    { database: fakeDatabase() },
  );
  assert.equal(unauthorized.status, 401);

  const authorized = await handleBackendRequest(
    inboundRequest('Bearer test-secret'),
    env,
    { database: fakeDatabase() },
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    ok: true,
    stored: false,
    reason: 'unknown_recipient',
  });
});

test('backend Worker keeps unauthenticated OpenAI context provisioning disabled', async () => {
  const response = await handleBackendRequest(
    new Request('https://backend.example/apps/openai/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _meta: { 'openai/subject': 'spoofed' } }),
    }),
    { ENABLE_UNAUTHENTICATED_OPENAI_CONTEXT: 'false' },
    { database: fakeDatabase() },
  );

  assert.equal(response.status, 404);
});

test('backend Worker rejects invalid JSON without leaking an internal error', async () => {
  const response = await handleBackendRequest(
    new Request('https://backend.example/webhooks/email/inbound', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
      body: '{invalid',
    }),
    { INBOUND_WEBHOOK_TOKEN: 'test-secret' },
    { database: fakeDatabase() },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Request body must be valid JSON.',
  });
});

function inboundRequest(authorization) {
  return new Request('https://backend.example/webhooks/email/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      provider: 'cloudflare',
      from: 'sender@example.com',
      to: 'unknown@in.test',
      subject: 'Worker test',
      text: 'Worker body',
      messageId: '<worker-test@example.com>',
      date: 'Sun, 19 Jul 2026 12:00:00 -0700',
    }),
  });
}

function fakeDatabase(queries = []) {
  return {
    async query(text) {
      queries.push(text);
      if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async transaction(callback) {
      return callback((text) => this.query(text));
    },
  };
}
