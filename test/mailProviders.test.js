import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareMailProvider, MailProviderError } from '../src/mailProviders.js';

test('Cloudflare provider requires account and token config', async () => {
  const provider = new CloudflareMailProvider({});

  await assert.rejects(
    provider.send({
      fromEmail: 'alias@example.com',
      toEmail: 'recipient@example.com',
      subject: 'Hello',
      textBody: 'Body',
    }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
});

test('Cloudflare provider sends through Email Sending REST API', async () => {
  const originalFetch = globalThis.fetch;
  let request;

  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        message_id: '<cloudflare-message@example.com>',
        delivered: ['recipient@example.com'],
        queued: [],
        permanent_bounces: [],
      },
    });
  };

  try {
    const provider = new CloudflareMailProvider({
      cloudflareAccountId: 'account-id',
      cloudflareApiToken: 'api-token',
    });

    const result = await provider.send({
      fromEmail: 'alias@example.com',
      fromName: 'Serguei via Shoot Email',
      toEmail: 'recipient@example.com',
      subject: 'Hello',
      textBody: 'Body',
    });

    assert.equal(
      request.url,
      'https://api.cloudflare.com/client/v4/accounts/account-id/email/sending/send',
    );
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer api-token');
    assert.deepEqual(JSON.parse(request.options.body), {
      from: {
        address: 'alias@example.com',
        name: 'Serguei via Shoot Email',
      },
      to: 'recipient@example.com',
      subject: 'Hello',
      text: 'Body',
    });
    assert.equal(result.provider, 'cloudflare');
    assert.equal(result.providerMessageId, '<cloudflare-message@example.com>');
    assert.equal(result.deliveryStatus, 'delivered');
    assert.deepEqual(result.deliveryDetails, {
      delivered: ['recipient@example.com'],
      queued: [],
      permanentBounces: [],
    });
    assert.equal(result.fromEmail, 'alias@example.com');
    assert.equal(result.fromName, 'Serguei via Shoot Email');
    assert.equal(result.toEmail, 'recipient@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare provider distinguishes known rejection from unknown outcome', async () => {
  const originalFetch = globalThis.fetch;
  const provider = new CloudflareMailProvider({
    cloudflareAccountId: 'account-id',
    cloudflareApiToken: 'api-token',
  });
  const message = {
    fromEmail: 'alias@example.com',
    toEmail: 'recipient@example.com',
    subject: 'Hello',
    textBody: 'Body',
  };

  try {
    globalThis.fetch = async () => Response.json({
      success: false,
      errors: [{ code: 10102, message: 'Forbidden' }],
    }, { status: 403 });

    await assert.rejects(provider.send(message), (error) => {
      assert.ok(error instanceof MailProviderError);
      assert.equal(error.code, '10102');
      assert.equal(error.outcomeKnown, true);
      return true;
    });

    globalThis.fetch = async () => {
      throw new Error('Connection reset');
    };

    await assert.rejects(provider.send(message), (error) => {
      assert.ok(error instanceof MailProviderError);
      assert.equal(error.code, 'network_error');
      assert.equal(error.outcomeKnown, false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare provider treats a successful message ID as accepted when recipient arrays are empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    success: true,
    errors: [],
    messages: [],
    result: {
      message_id: '<accepted@example.com>',
      delivered: [],
      queued: [],
      permanent_bounces: [],
    },
  });

  try {
    const provider = new CloudflareMailProvider({
      cloudflareAccountId: 'account-id',
      cloudflareApiToken: 'api-token',
    });
    const result = await provider.send({
      fromEmail: 'alias@example.com',
      toEmail: 'recipient@example.com',
      subject: 'Hello',
      textBody: 'Body',
    });

    assert.equal(result.deliveryStatus, 'queued');
    assert.equal(result.providerMessageId, '<accepted@example.com>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
