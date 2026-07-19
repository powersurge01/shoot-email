import crypto from 'node:crypto';
import { closePool } from './db.js';
import {
  acknowledgeMessages,
  findOrCreateOpenAiContext,
  listInbox,
} from './services.js';

const backendUrl = process.env.HOSTED_BACKEND_URL;
const webhookToken = process.env.INBOUND_WEBHOOK_TOKEN;

if (!backendUrl || !webhookToken || !process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL, HOSTED_BACKEND_URL, and INBOUND_WEBHOOK_TOKEN are required.',
  );
}

const runId = crypto.randomUUID();
const marker = `HOSTED-INBOUND-${runId.slice(0, 8)}`;

try {
  const context = await findOrCreateOpenAiContext({
    subject: `hosted-smoke-${runId}`,
    session: `hosted-smoke-session-${runId}`,
    organization: 'shoot-email-staging',
  });
  const alias = context.user.email_alias;

  const response = await fetch(
    new URL('/webhooks/email/inbound', backendUrl),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${webhookToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'cloudflare',
        from: 'staging-sender@example.com',
        to: alias,
        subject: marker,
        text: 'Synthetic hosted inbound smoke test.',
        messageId: `<${marker.toLowerCase()}@example.com>`,
        date: new Date().toISOString(),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Hosted webhook returned ${response.status}.`);
  }
  const webhook = await response.json();
  if (!webhook.stored) {
    throw new Error(`Hosted webhook did not store the message: ${webhook.reason}`);
  }

  const inbox = await listInbox({ userId: context.user.id });
  const message = inbox.messages.find((candidate) => candidate.subject === marker);
  if (!message) {
    throw new Error('Stored hosted message was not returned by inbox retrieval.');
  }

  const acknowledgement = await acknowledgeMessages(
    [message.id],
    { userId: context.user.id },
  );
  if (!acknowledgement.allSucceeded) {
    throw new Error('Hosted message acknowledgement was not fully successful.');
  }

  console.log(JSON.stringify({
    ok: true,
    mailbox: alias,
    marker,
    webhookStored: webhook.stored,
    retrieved: true,
    acknowledged: acknowledgement.allSucceeded,
  }, null, 2));
} finally {
  await closePool();
}
