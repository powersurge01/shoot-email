import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../workers/email-router/src/index.js';

test('Email Worker authenticates normalized webhook delivery', async () => {
  const originalFetch = globalThis.fetch;
  let request;

  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 200 });
  };

  try {
    await worker.email(
      {
        from: 'sender@example.com',
        to: 'u_example@yoyowza.com',
        raw: new Response(
          [
            'From: sender@example.com',
            'To: u_example@yoyowza.com',
            'Subject: Worker authentication',
            'Message-ID: <worker-auth@example.com>',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Authenticated body',
          ].join('\r\n'),
        ).body,
      },
      {
        BACKEND_INBOUND_WEBHOOK_URL: 'https://webhook.example.test/inbound',
        INBOUND_WEBHOOK_TOKEN: 'worker-secret',
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://webhook.example.test/inbound');
  assert.equal(request.options.headers.Authorization, 'Bearer worker-secret');

  const body = JSON.parse(request.options.body);
  assert.equal(body.provider, 'cloudflare');
  assert.equal(body.subject, 'Worker authentication');
  assert.equal(body.text.trim(), 'Authenticated body');
  assert.equal(body.messageId, '<worker-auth@example.com>');
});

test('Email Worker derives a stable identifier when Message-ID is missing', async () => {
  const originalFetch = globalThis.fetch;
  const messageIds = [];

  globalThis.fetch = async (_url, options) => {
    messageIds.push(JSON.parse(options.body).messageId);
    return new Response(null, { status: 200 });
  };

  const raw = [
    'From: sender@example.com',
    'To: u_example@yoyowza.com',
    'Subject: No message ID',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Identical retries must deduplicate.',
  ].join('\r\n');

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await worker.email(
        {
          from: 'sender@example.com',
          to: 'u_example@yoyowza.com',
          raw: new Response(raw).body,
        },
        {
          BACKEND_INBOUND_WEBHOOK_URL: 'https://webhook.example.test/inbound',
          INBOUND_WEBHOOK_TOKEN: 'worker-secret',
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(messageIds.length, 2);
  assert.equal(messageIds[0], messageIds[1]);
  assert.match(messageIds[0], /^sha256:[a-f0-9]{64}$/);
});
