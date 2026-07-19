import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MAIL_PROVIDER = 'mock';
process.env.INBOUND_DOMAIN = 'in.test';
process.env.INBOUND_WEBHOOK_TOKEN = 'integration-webhook-token';
process.env.SHOOT_EMAIL_CONFIG_DIR = await fs.mkdtemp(
  path.join(os.tmpdir(), 'shoot-email-test-'),
);

const { closePool, query, runWithDatabase, transaction } = await import('../src/db.js');
const { createRequestDatabase } = await import('../src/hyperdriveDb.js');
const { createApp } = await import('../src/server.js');
const { normalizeInboundPayload } = await import('../src/inboundEmail.js');
const { resetDatabase } = await import('../src/resetDb.js');
const {
  acknowledgeMessages,
  clearSenderDisplayName,
  findOrCreateOpenAiContext,
  getAbuseStatus,
  getOutboundStatus,
  getSenderIdentity,
  getServiceStatus,
  initMailbox,
  ingestInboundMessage,
  listHistory,
  listInbox,
  listOutboundHistory,
  readMessage,
  reactivateSending,
  sendEmail,
  setAccountTier,
  setCustomEmailAlias,
  setSenderDisplayName,
  suspendSending,
} = await import('../src/services.js');

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await closePool();
  await fs.rm(process.env.SHOOT_EMAIL_CONFIG_DIR, {
    force: true,
    recursive: true,
  });
});

test('request-scoped database adapter supports queries and transactions', async () => {
  const database = createRequestDatabase(process.env.DATABASE_URL);
  try {
    await runWithDatabase(database, async () => {
      const direct = await query('SELECT 41::int AS value');
      assert.equal(direct.rows[0].value, 41);

      const transactional = await transaction(
        (txQuery) => txQuery('SELECT 42::int AS value'),
      );
      assert.equal(transactional.rows[0].value, 42);
    });
  } finally {
    await database.close();
  }
});

test('mailbox init, mock send, inbound ingest, inbox, and read work against Postgres', async () => {
  const initialized = await initMailbox();
  assert.equal(initialized.created, true);
  assert.match(initialized.user.email_alias, /^u_[a-f0-9]{8}@in\.test$/);

  const reused = await initMailbox();
  assert.equal(reused.created, false);
  assert.equal(reused.user.id, initialized.user.id);

  const outbound = await sendEmail({
    requestId: '10000000-0000-4000-8000-000000000001',
    toEmail: 'recipient@example.com',
    subject: 'Integration outbound',
    textBody: 'Outbound body',
  });

  assert.equal(outbound.ok, true);
  assert.equal(outbound.idempotentReplay, false);
  assert.equal(outbound.message.provider, 'mock');
  assert.equal(outbound.message.deliveryStatus, 'delivered');
  assert.equal(outbound.message.requestId, '10000000-0000-4000-8000-000000000001');

  const mockUsage = await query('SELECT count(*)::int AS count FROM outbound_usage_buckets');
  assert.equal(mockUsage.rows[0].count, 0);

  const inboundPayload = normalizeInboundPayload({
    provider: 'cloudflare',
    from: 'sender@example.com',
    to: initialized.user.email_alias,
    subject: 'Integration inbound',
    text: 'Inbound body',
    messageId: '<cloudflare-integration-1@example.com>',
    date: 'Thu, 09 Jul 2026 19:45:00 -0700',
  });

  const inbound = await ingestInboundMessage(inboundPayload);
  assert.equal(inbound.stored, true);
  assert.equal(inbound.message.direction, 'inbound');
  assert.equal(inbound.message.user_id, initialized.user.id);

  const inbox = await listInbox({ limit: 10 });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, inbound.message.id);
  assert.equal(inbox.messages[0].subject, 'Integration inbound');
  assert.equal(inbox.messages[0].text, 'Inbound body');
  assert.equal(inbox.messages[0].processingStatus, 'pending');
  assert.equal(inbox.messages[0].contentTrust, 'untrusted_external');
  assert.equal(inbox.messages[0].bodyTruncated, false);

  const read = await readMessage(inbound.message.id);
  assert.equal(read.message.text, 'Inbound body');
  assert.equal(read.retrievalChangedProcessingState, false);
});

test('sender identity is validated, persisted, formatted, and used for outbound mail', async () => {
  await initMailbox();

  const initial = await getSenderIdentity();
  assert.equal(initial.ok, true);
  assert.equal(initial.identity.displayName, null);
  assert.equal(initial.identity.senderName, 'Shoot Email');
  assert.match(initial.identity.formatted, /^Shoot Email <u_[a-f0-9]{8}@in\.test>$/);

  const configured = await setSenderDisplayName('  Serguei   Vinnitskii  ');
  assert.equal(configured.identity.displayName, 'Serguei Vinnitskii');
  assert.equal(configured.identity.senderName, 'Serguei Vinnitskii via Shoot Email');

  const sent = await sendEmail({
    requestId: '15000000-0000-4000-8000-000000000001',
    toEmail: 'recipient@example.com',
    subject: 'Named sender',
    textBody: 'Display identity test.',
  });
  assert.deepEqual(sent.message.from, {
    address: configured.identity.address,
    name: 'Serguei Vinnitskii via Shoot Email',
  });

  await assert.rejects(
    setSenderDisplayName('attacker@example.com'),
    (error) => error.code === 'invalid_display_name',
  );
  await assert.rejects(
    setSenderDisplayName('Header\nInjection'),
    (error) => error.code === 'invalid_display_name',
  );

  const cleared = await clearSenderDisplayName();
  assert.equal(cleared.identity.displayName, null);
  assert.equal(cleared.identity.senderName, 'Shoot Email');

  const identityConflict = await sendEmail({
    requestId: '15000000-0000-4000-8000-000000000001',
    toEmail: 'recipient@example.com',
    subject: 'Named sender',
    textBody: 'Display identity test.',
  });
  assert.equal(identityConflict.ok, false);
  assert.equal(identityConflict.error.code, 'idempotency_key_reused');
});

test('registered custom aliases are reserved permanently and retain old inbound delivery', async () => {
  const initialized = await initMailbox();
  const generatedAddress = initialized.user.email_alias;

  await assert.rejects(
    setCustomEmailAlias('serguei'),
    (error) => error.code === 'registration_required',
  );

  await setAccountTier(initialized.user.id, 'registered');
  await assert.rejects(
    setCustomEmailAlias('support-team'),
    (error) => error.code === 'reserved_alias',
  );

  const changed = await setCustomEmailAlias('Serguei.Mail');
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true);
  assert.equal(changed.previousAddress, generatedAddress);
  assert.equal(changed.identity.address, 'serguei.mail@in.test');
  assert.equal(changed.alias.localPart, 'serguei.mail');

  const unchanged = await setCustomEmailAlias('serguei.mail');
  assert.equal(unchanged.changed, false);

  await assert.rejects(
    setCustomEmailAlias('another-alias'),
    (error) => error.code === 'alias_change_cooldown' && Boolean(error.retryAfter),
  );

  const oldAddressInbound = await ingestInboundMessage(normalizeInboundPayload({
    provider: 'cloudflare',
    from: 'old-address-reply@example.com',
    to: generatedAddress,
    subject: 'Reply to retired alias',
    text: 'The retired alias still resolves to its original user.',
    messageId: '<retired-alias-reply@example.com>',
  }));
  const newAddressInbound = await ingestInboundMessage(normalizeInboundPayload({
    provider: 'cloudflare',
    from: 'new-address-reply@example.com',
    to: changed.identity.address,
    subject: 'Reply to current alias',
    text: 'The current alias resolves too.',
    messageId: '<current-alias-reply@example.com>',
  }));
  assert.equal(oldAddressInbound.user.id, initialized.user.id);
  assert.equal(newAddressInbound.user.id, initialized.user.id);

  const aliases = await query(
    `SELECT email_alias, status FROM user_email_aliases
     WHERE user_id = $1 ORDER BY created_at`,
    [initialized.user.id],
  );
  assert.deepEqual(aliases.rows, [
    { email_alias: generatedAddress, status: 'retired' },
    { email_alias: 'serguei.mail@in.test', status: 'current' },
  ]);

  const other = await findOrCreateOpenAiContext({
    subject: 'other-alias-user',
    session: 'other-alias-session',
  });
  await assert.rejects(
    query(
      `INSERT INTO user_email_aliases (email_alias, user_id, status)
       VALUES ($1, $2, 'current')`,
      [generatedAddress, other.user.id],
    ),
    (error) => error.code === '23505',
  );
});

test('outbound sends are idempotent across concurrent retries and reject changed content', async () => {
  await initMailbox();
  let providerCalls = 0;
  const provider = {
    name: 'counting_mock',
    async send({ fromEmail, toEmail, subject, textBody }) {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        provider: 'counting_mock',
        providerMessageId: '<counting-mock@example.com>',
        deliveryStatus: 'delivered',
        deliveryDetails: {
          delivered: [toEmail],
          queued: [],
          permanentBounces: [],
        },
        submittedAt: new Date('2026-07-16T00:00:00.000Z'),
        fromEmail,
        toEmail,
        subject,
        textBody,
      };
    },
  };
  const request = {
    requestId: '20000000-0000-4000-8000-000000000002',
    toEmail: 'recipient@example.com',
    subject: 'Idempotent outbound',
    textBody: 'Send this exactly once.',
    mailProvider: provider,
  };

  const concurrent = await Promise.all([sendEmail(request), sendEmail(request)]);
  assert.equal(providerCalls, 1);
  assert.equal(concurrent.filter((result) => result.idempotentReplay).length, 1);

  const replay = await sendEmail(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.message.providerMessageId, '<counting-mock@example.com>');
  assert.equal(providerCalls, 1);

  const conflict = await sendEmail({
    ...request,
    textBody: 'Changed content must not be sent.',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.idempotentReplay, false);
  assert.equal(conflict.existingRequest, true);
  assert.equal(conflict.providerCalled, false);
  assert.equal(conflict.message, null);
  assert.equal(conflict.existingMessage.text, 'Send this exactly once.');
  assert.equal(conflict.error.code, 'idempotency_key_reused');
  assert.equal(providerCalls, 1);

  const rows = await query(
    'SELECT count(*)::int AS count FROM messages WHERE direction = $1',
    ['outbound'],
  );
  assert.equal(rows.rows[0].count, 1);
});

test('ambiguous provider failure becomes unknown and is not sent again', async () => {
  await initMailbox();
  let providerCalls = 0;
  const provider = {
    name: 'ambiguous_mock',
    async send() {
      providerCalls += 1;
      const error = new Error('Connection closed before a response was received.');
      error.code = 'network_error';
      error.outcomeKnown = false;
      throw error;
    },
  };
  const request = {
    requestId: '30000000-0000-4000-8000-000000000003',
    toEmail: 'recipient@example.com',
    subject: 'Ambiguous outbound',
    textBody: 'Do not retry automatically.',
    mailProvider: provider,
  };

  const first = await sendEmail(request);
  assert.equal(first.ok, false);
  assert.equal(first.message.deliveryStatus, 'unknown');
  assert.equal(first.error.code, 'network_error');

  const replay = await sendEmail(request);
  assert.equal(replay.ok, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(providerCalls, 1);
});

test('service status and outbound queries expose an LLM-safe read contract', async () => {
  await initMailbox();
  const status = await getServiceStatus();
  assert.equal(status.provider.name, 'mock');
  assert.equal(status.provider.mode, 'simulation');
  assert.equal(status.provider.simulated, true);
  assert.equal(status.service.environment, 'test');
  assert.match(status.service.serverTime, /Z$/);
  assert.equal(status.outbound.available, true);
  assert.deepEqual(status.account, { tier: 'guest' });
  assert.equal(status.quotas.userHourly.limit, 3);
  assert.equal(status.quotas.sessionHourly, null);
  assert.equal(status.constraints.retrieval.maximums.limit, 200);

  const first = await sendEmail({
    requestId: '39000000-0000-4000-8000-000000000001',
    toEmail: 'first@example.com',
    subject: 'First outbound query',
    textBody: 'First outbound body.',
  });
  const second = await sendEmail({
    requestId: '39000000-0000-4000-8000-000000000002',
    toEmail: 'second@example.com',
    subject: 'Second outbound query',
    textBody: 'Second outbound body.',
  });

  const outbound = await listOutboundHistory({ limit: 1 });
  assert.equal(outbound.messages.length, 1);
  assert.equal(outbound.messages[0].id, second.message.id);
  assert.equal(outbound.messages[0].simulated, true);
  assert.equal(outbound.hasMore, true);
  assert.ok(outbound.nextCursor);
  assert.equal(outbound.page.order[0].direction, 'descending');

  const next = await listOutboundHistory({
    limit: 1,
    cursor: outbound.nextCursor,
  });
  assert.equal(next.messages[0].id, first.message.id);

  const byRequest = await getOutboundStatus({
    requestId: first.message.requestId,
  });
  assert.equal(byRequest.message.id, first.message.id);
  assert.equal(byRequest.providerCalled, false);
  assert.equal(byRequest.simulated, true);
});

test('concurrent sends cannot exceed an atomic user quota and rejection is idempotent', async () => {
  await initMailbox();
  let providerCalls = 0;
  const provider = countingProvider(() => {
    providerCalls += 1;
  });

  await withEnvironment({
    OUTBOUND_GUEST_HOURLY_LIMIT: '1',
    OUTBOUND_GUEST_DAILY_LIMIT: '10',
    OUTBOUND_GUEST_NEW_RECIPIENT_DAILY_LIMIT: '10',
    OUTBOUND_GUEST_MIN_INTERVAL_SECONDS: '1',
  }, async () => {
    const requests = [
      {
        requestId: '41000000-0000-4000-8000-000000000001',
        toEmail: 'first@example.com',
        subject: 'First concurrent send',
        textBody: 'Only one provider call is allowed.',
        mailProvider: provider,
      },
      {
        requestId: '41000000-0000-4000-8000-000000000002',
        toEmail: 'second@example.com',
        subject: 'Second concurrent send',
        textBody: 'This request should be rejected.',
        mailProvider: provider,
      },
    ];

    const results = await Promise.all(requests.map((request) => sendEmail(request)));
    const accepted = results.find((result) => result.ok);
    const rejected = results.find((result) => !result.ok);

    assert.ok(accepted);
    assert.equal(rejected.error.code, 'rate_limited');
    assert.equal(rejected.error.limitType, 'user_hourly');
    assert.ok(rejected.error.retryAt);
    assert.equal(providerCalls, 1);

    const rejectedRequest = requests.find(
      (request) => request.requestId === rejected.message.requestId,
    );
    const replay = await sendEmail(rejectedRequest);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.message.id, rejected.message.id);
    assert.equal(replay.error.limitType, 'user_hourly');
    assert.equal(providerCalls, 1);

    const usage = await query(
      `SELECT used_count FROM outbound_usage_buckets
       WHERE scope_type = 'user' AND bucket_type = 'hour'`,
    );
    assert.equal(usage.rows[0].used_count, 1);
  });
});

test('new-recipient quota exempts an address with a prior inbound relationship', async () => {
  const initialized = await initMailbox();
  let providerCalls = 0;
  const provider = countingProvider(() => {
    providerCalls += 1;
  });

  await ingestInboundMessage(normalizeInboundPayload({
    provider: 'cloudflare',
    from: 'known@example.com',
    to: initialized.user.email_alias,
    subject: 'Existing relationship',
    text: 'You can reply without consuming new-recipient quota.',
    messageId: '<known-contact@example.com>',
  }));

  await withEnvironment({
    OUTBOUND_GUEST_HOURLY_LIMIT: '10',
    OUTBOUND_GUEST_DAILY_LIMIT: '10',
    OUTBOUND_GUEST_NEW_RECIPIENT_DAILY_LIMIT: '1',
    OUTBOUND_GUEST_MIN_INTERVAL_SECONDS: '1',
  }, async () => {
    const first = await sendEmail({
      requestId: '42000000-0000-4000-8000-000000000001',
      toEmail: 'new@example.com',
      subject: 'First new recipient',
      textBody: 'This consumes the new-recipient allowance.',
      mailProvider: provider,
    });
    assert.equal(first.ok, true);
    await ageLastSendAttempt(initialized.user.id);

    const blocked = await sendEmail({
      requestId: '42000000-0000-4000-8000-000000000002',
      toEmail: 'another-new@example.com',
      subject: 'Another new recipient',
      textBody: 'This should be blocked.',
      mailProvider: provider,
    });
    assert.equal(blocked.error.limitType, 'new_recipients_daily');

    const reply = await sendEmail({
      requestId: '42000000-0000-4000-8000-000000000003',
      toEmail: 'KNOWN@example.com',
      subject: 'Reply to existing contact',
      textBody: 'This should still be allowed.',
      mailProvider: provider,
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.message.to, ['known@example.com']);
    assert.equal(providerCalls, 2);
  });
});

test('tier upgrades preserve usage while applying registered limits', async () => {
  const initialized = await initMailbox();
  const provider = countingProvider(() => {});

  await withEnvironment({
    OUTBOUND_GUEST_HOURLY_LIMIT: '1',
    OUTBOUND_GUEST_DAILY_LIMIT: '1',
    OUTBOUND_GUEST_NEW_RECIPIENT_DAILY_LIMIT: '1',
    OUTBOUND_GUEST_MIN_INTERVAL_SECONDS: '1',
    OUTBOUND_REGISTERED_HOURLY_LIMIT: '2',
    OUTBOUND_REGISTERED_DAILY_LIMIT: '2',
    OUTBOUND_REGISTERED_NEW_RECIPIENT_DAILY_LIMIT: '2',
    OUTBOUND_REGISTERED_MIN_INTERVAL_SECONDS: '1',
  }, async () => {
    const first = await sendEmail({
      requestId: '43000000-0000-4000-8000-000000000001',
      toEmail: 'one@example.com',
      subject: 'Guest allowance',
      textBody: 'First send.',
      mailProvider: provider,
    });
    assert.equal(first.ok, true);
    await ageLastSendAttempt(initialized.user.id);

    const upgraded = await setAccountTier(initialized.user.id, 'registered');
    assert.equal(upgraded.user.accountTier, 'registered');

    const second = await sendEmail({
      requestId: '43000000-0000-4000-8000-000000000002',
      toEmail: 'two@example.com',
      subject: 'Registered allowance',
      textBody: 'Second send uses remaining registered capacity.',
      mailProvider: provider,
    });
    assert.equal(second.ok, true);
    await ageLastSendAttempt(initialized.user.id);

    const exhausted = await sendEmail({
      requestId: '43000000-0000-4000-8000-000000000003',
      toEmail: 'three@example.com',
      subject: 'No quota reset',
      textBody: 'This should be blocked because prior guest usage remains.',
      mailProvider: provider,
    });
    assert.equal(exhausted.error.limitType, 'user_hourly');

    const status = await getAbuseStatus(initialized.user.id);
    const hourly = status.usage.find(
      (usage) => usage.scopeType === 'user' && usage.bucketType === 'hour',
    );
    assert.equal(hourly.used, 2);
  });
});

test('session limits, suspension, and the global kill switch reject before provider calls', async () => {
  const initialized = await initMailbox();
  const sessionId = '44000000-0000-4000-8000-000000000001';
  await query(
    `INSERT INTO chat_sessions (
      id, user_id, provider, provider_session, provider_subject
    ) VALUES ($1, $2, 'openai_apps', 'session-abuse-test', 'subject-abuse-test')`,
    [sessionId, initialized.user.id],
  );

  let providerCalls = 0;
  const provider = countingProvider(() => {
    providerCalls += 1;
  });

  await withEnvironment({
    OUTBOUND_GUEST_HOURLY_LIMIT: '10',
    OUTBOUND_GUEST_DAILY_LIMIT: '10',
    OUTBOUND_GUEST_NEW_RECIPIENT_DAILY_LIMIT: '10',
    OUTBOUND_GUEST_MIN_INTERVAL_SECONDS: '1',
    OUTBOUND_GUEST_SESSION_HOURLY_LIMIT: '1',
  }, async () => {
    const first = await sendEmail({
      requestId: '44000000-0000-4000-8000-000000000002',
      chatSessionId: sessionId,
      toEmail: 'session-one@example.com',
      subject: 'Session allowance',
      textBody: 'First session send.',
      mailProvider: provider,
    });
    assert.equal(first.ok, true);
    await ageLastSendAttempt(initialized.user.id);

    const sessionBlocked = await sendEmail({
      requestId: '44000000-0000-4000-8000-000000000003',
      chatSessionId: sessionId,
      toEmail: 'session-two@example.com',
      subject: 'Session limit',
      textBody: 'Blocked by the session limit.',
      mailProvider: provider,
    });
    assert.equal(sessionBlocked.error.limitType, 'session_hourly');

    await suspendSending(initialized.user.id, 'Integration-test suspension');
    const suspended = await sendEmail({
      requestId: '44000000-0000-4000-8000-000000000004',
      toEmail: 'suspended@example.com',
      subject: 'Suspended send',
      textBody: 'This must not reach the provider.',
      mailProvider: provider,
    });
    assert.equal(suspended.error.code, 'sending_suspended');
    assert.equal(suspended.error.limitType, 'user_suspended');

    await reactivateSending(initialized.user.id);
    await withEnvironment({ OUTBOUND_SENDING_ENABLED: 'false' }, async () => {
      const disabled = await sendEmail({
        requestId: '44000000-0000-4000-8000-000000000005',
        toEmail: 'disabled@example.com',
        subject: 'Global kill switch',
        textBody: 'This must not reach the provider.',
        mailProvider: provider,
      });
      assert.equal(disabled.error.code, 'sending_disabled');
      assert.equal(disabled.error.limitType, 'global_kill_switch');
    });

    assert.equal(providerCalls, 1);
  });
});

test('inbox paginates full pending messages and acknowledgement moves them to history', async () => {
  const initialized = await initMailbox();
  const inboundMessages = [];

  for (const [index, body] of ['abcdefghij', 'klmnopqrst', 'uvwxyz'].entries()) {
    const inbound = await ingestInboundMessage(normalizeInboundPayload({
      provider: 'cloudflare',
      from: `sender-${index}@example.com`,
      to: initialized.user.email_alias,
      subject: `Message ${index}`,
      text: body,
      messageId: `<batch-${index}@example.com>`,
      date: `Thu, 09 Jul 2026 19:5${index}:00 -0700`,
    }));
    inboundMessages.push(inbound.message);
    await query(
      'UPDATE messages SET created_at = $1 WHERE id = $2',
      [`2026-07-10T00:0${index}:00.000Z`, inbound.message.id],
    );
  }

  const firstPage = await listInbox({ limit: 2 });
  assert.deepEqual(
    firstPage.messages.map((message) => message.id),
    inboundMessages.slice(0, 2).map((message) => message.id),
  );
  assert.equal(firstPage.messages[0].text, 'abcdefghij');
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const secondPage = await listInbox({
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(
    secondPage.messages.map((message) => message.id),
    [inboundMessages[2].id],
  );
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextCursor, null);
  await assert.rejects(
    listHistory({ cursor: firstPage.nextCursor }),
    (error) => error.code === 'invalid_cursor',
  );

  const bounded = await listInbox({
    limit: 3,
    maxChars: 10,
    maxMessageChars: 6,
  });
  assert.equal(bounded.returnedChars, 10);
  assert.equal(bounded.messages.length, 2);
  assert.equal(bounded.messages[0].text, 'abcdef');
  assert.equal(bounded.messages[0].bodyTruncated, true);
  assert.equal(bounded.messages[0].originalBodyChars, 10);
  assert.equal(bounded.messages[1].text, 'klmn');
  assert.equal(bounded.hasMore, true);

  const firstAcknowledgement = await acknowledgeMessages([
    inboundMessages[0].id,
    inboundMessages[1].id,
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ]);
  assert.deepEqual(
    firstAcknowledgement.acknowledged.sort(),
    inboundMessages.slice(0, 2).map((message) => message.id).sort(),
  );
  assert.deepEqual(firstAcknowledgement.alreadyProcessed, []);
  assert.deepEqual(firstAcknowledgement.notFound, [
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ]);
  assert.equal(firstAcknowledgement.batchSemantics, 'partial_by_id');

  const repeatedAcknowledgement = await acknowledgeMessages([
    inboundMessages[0].id,
  ]);
  assert.deepEqual(repeatedAcknowledgement.acknowledged, []);
  assert.deepEqual(repeatedAcknowledgement.alreadyProcessed, [inboundMessages[0].id]);

  const pending = await listInbox();
  assert.deepEqual(
    pending.messages.map((message) => message.id),
    [inboundMessages[2].id],
  );

  const history = await listHistory();
  assert.deepEqual(
    history.messages.map((message) => message.id),
    inboundMessages.slice(0, 2).map((message) => message.id),
  );
});

test('inbox defaults to 50 messages and returns a cursor when more are pending', async () => {
  const initialized = await initMailbox();

  await query(
    `
      INSERT INTO messages (
        id,
        user_id,
        direction,
        from_email,
        to_email,
        subject,
        text_body,
        processing_status,
        received_at,
        created_at
      )
      SELECT
        ('00000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
        $1,
        'inbound',
        'sender-' || sequence || '@example.com',
        $2,
        'Default batch ' || sequence,
        'Body ' || sequence,
        'pending',
        '2026-07-10T00:00:00.000Z'::timestamptz + sequence * interval '1 second',
        '2026-07-10T00:00:00.000Z'::timestamptz + sequence * interval '1 second'
      FROM generate_series(1, 51) AS sequence
    `,
    [initialized.user.id, initialized.user.email_alias],
  );

  const firstPage = await listInbox();
  assert.equal(firstPage.messages.length, 50);
  assert.equal(firstPage.messages[0].subject, 'Default batch 1');
  assert.equal(firstPage.messages[49].subject, 'Default batch 50');
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const secondPage = await listInbox({ cursor: firstPage.nextCursor });
  assert.equal(secondPage.messages.length, 1);
  assert.equal(secondPage.messages[0].subject, 'Default batch 51');
  assert.equal(secondPage.hasMore, false);
});

test('generic inbound email webhook stores Cloudflare-normalized messages', async () => {
  const initialized = await initMailbox();
  const app = createApp();
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/webhooks/email/inbound`;
    const response = await postJson(url, {
      provider: 'cloudflare',
      from: 'sender@example.com',
      to: initialized.user.email_alias,
      subject: 'Webhook inbound',
      text: 'Stored through generic email webhook',
      messageId: '<cloudflare-webhook-1@example.com>',
      date: 'Thu, 09 Jul 2026 19:50:00 -0700',
    }, process.env.INBOUND_WEBHOOK_TOKEN);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.stored, true);

    const read = await readMessage(response.body.messageId);
    assert.equal(read.message.subject, 'Webhook inbound');
    assert.equal(read.message.providerMessageId, '<cloudflare-webhook-1@example.com>');

    const duplicate = await postJson(url, {
      provider: 'cloudflare',
      from: 'sender@example.com',
      to: initialized.user.email_alias,
      subject: 'Webhook inbound retry',
      text: 'A retry must not replace the original message.',
      messageId: '<cloudflare-webhook-1@example.com>',
      date: 'Thu, 09 Jul 2026 19:51:00 -0700',
    }, process.env.INBOUND_WEBHOOK_TOKEN);

    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.stored, false);
    assert.equal(duplicate.body.reason, 'duplicate');
    assert.equal(duplicate.body.messageId, response.body.messageId);

    const rows = await query(
      'SELECT subject, text_body FROM messages WHERE provider_message_id = $1',
      ['<cloudflare-webhook-1@example.com>'],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].subject, 'Webhook inbound');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('inbound webhook rejects missing and incorrect credentials', async () => {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/webhooks/email/inbound`;
    const payload = {
      provider: 'cloudflare',
      from: 'sender@example.com',
      to: 'unknown@in.test',
      subject: 'Unauthorized webhook',
      text: 'This must not be ingested.',
    };

    const missing = await postJson(url, payload);
    assert.equal(missing.status, 401);

    const incorrect = await postJson(url, payload, 'incorrect-token');
    assert.equal(incorrect.status, 401);

    const configuredToken = process.env.INBOUND_WEBHOOK_TOKEN;
    process.env.INBOUND_WEBHOOK_TOKEN = '';
    try {
      const unconfigured = await postJson(url, payload);
      assert.equal(unconfigured.status, 503);
    } finally {
      process.env.INBOUND_WEBHOOK_TOKEN = configuredToken;
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('OpenAI subject and session map to stable user and chat session rows', async () => {
  const first = await findOrCreateOpenAiContext({
    subject: 'anon-user-1',
    session: 'chat-session-1',
    organization: 'org-1',
  });

  const second = await findOrCreateOpenAiContext({
    subject: 'anon-user-1',
    session: 'chat-session-1',
    organization: 'org-1',
  });

  assert.equal(second.user.id, first.user.id);
  assert.equal(second.chatSession.id, first.chatSession.id);

  const third = await findOrCreateOpenAiContext({
    subject: 'anon-user-1',
    session: 'chat-session-2',
    organization: 'org-1',
  });

  assert.equal(third.user.id, first.user.id);
  assert.notEqual(third.chatSession.id, first.chatSession.id);

  const identityRows = await query('SELECT count(*)::int AS count FROM user_identities');
  const sessionRows = await query('SELECT count(*)::int AS count FROM chat_sessions');

  assert.equal(identityRows.rows[0].count, 1);
  assert.equal(sessionRows.rows[0].count, 2);
});

test('OpenAI Apps context endpoint accepts _meta and reuses identity/session rows', async () => {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/apps/openai/context`;
    const payload = {
      _meta: {
        'openai/subject': 'anon-user-http-1',
        'openai/session': 'chat-session-http-1',
        'openai/organization': 'org-http-1',
      },
    };

    const first = await postJson(url, payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.match(first.body.user.emailAlias, /^u_[a-f0-9]{8}@in\.test$/);
    assert.ok(first.body.chatSession.id);

    const second = await postJson(url, payload);
    assert.equal(second.status, 200);
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal(second.body.chatSession.id, first.body.chatSession.id);

    const missingSubject = await postJson(url, {
      _meta: {
        'openai/session': 'chat-session-http-2',
      },
    });
    assert.equal(missingSubject.status, 400);
    assert.equal(missingSubject.body.ok, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function postJson(url, body, bearerToken) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearerToken
        ? { Authorization: `Bearer ${bearerToken}` }
        : {}),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function countingProvider(onSend) {
  return {
    name: 'counting_mock',
    async send({ toEmail }) {
      onSend();
      return {
        provider: 'counting_mock',
        providerMessageId: `<${cryptoRandomId()}@counting-mock.test>`,
        deliveryStatus: 'delivered',
        deliveryDetails: { delivered: [toEmail] },
        submittedAt: new Date(),
      };
    },
  };
}

async function ageLastSendAttempt(userId) {
  await query(
    `UPDATE messages
     SET last_send_attempt_at = now() - interval '1 minute'
     WHERE user_id = $1 AND direction = 'outbound'`,
    [userId],
  );
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
