import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCloudflareInboundPayload,
  normalizeInboundPayload,
} from '../src/inboundEmail.js';

test('normalizes a Cloudflare Worker inbound payload', () => {
  const normalized = normalizeCloudflareInboundPayload({
    provider: 'cloudflare',
    from: 'sender@example.com',
    to: 'u_1234@in.localhost',
    subject: 'Hello',
    text: 'Plain text body',
    messageId: '<cloudflare-message-id@example.com>',
    date: 'Tue, 07 Jul 2026 17:00:00 -0700',
  });

  assert.equal(normalized.fromEmail, 'sender@example.com');
  assert.equal(normalized.toEmail, 'u_1234@in.localhost');
  assert.equal(normalized.subject, 'Hello');
  assert.equal(normalized.textBody, 'Plain text body');
  assert.equal(normalized.providerMessageId, '<cloudflare-message-id@example.com>');
  assert.equal(normalized.receivedAt.toISOString(), '2026-07-08T00:00:00.000Z');
});

test('falls back to textBody in generic payloads', () => {
  const normalized = normalizeInboundPayload({
    fromEmail: 'sender@example.com',
    toEmail: 'u_1234@in.localhost',
    textBody: 'Reply text',
  });

  assert.equal(normalized.textBody, 'Reply text');
});
