import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');

process.env.NODE_ENV = 'test';
process.env.MAIL_PROVIDER = 'mock';
process.env.INBOUND_DOMAIN = 'in.test';
process.env.SHOOT_EMAIL_CONFIG_DIR = await fs.mkdtemp(
  path.join(os.tmpdir(), 'shoot-email-cli-contract-'),
);

const { closePool } = await import('../src/db.js');
const { normalizeInboundPayload } = await import('../src/inboundEmail.js');
const { resetDatabase } = await import('../src/resetDb.js');
const { ingestInboundMessage } = await import('../src/services.js');

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

test('CLI contract works end to end through subprocess JSON and exit codes', async () => {
  const initialized = await runCli(['init']);
  assert.equal(initialized.exitCode, 0);
  assertContractSuccess(initialized.body);
  assert.equal(initialized.body.created, true);
  const address = initialized.body.mailbox.address;

  const status = await runCli(['status']);
  assertContractSuccess(status.body);
  assert.equal(status.body.provider.mode, 'simulation');
  assert.equal(status.body.provider.simulated, true);
  assert.equal(status.body.outbound.available, true);
  assert.equal(status.body.quotas.userHourly.remaining, 3);

  const requestId = '90000000-0000-4000-8000-000000000001';
  const sendArgs = [
    'send',
    '--request-id', requestId,
    '--to', 'recipient@example.com',
    '--subject', 'CLI contract test',
    '--text', 'This is simulated and must be sent exactly once.',
  ];
  const firstSend = await runCli(sendArgs);
  assertContractSuccess(firstSend.body);
  assert.equal(firstSend.body.providerCalled, true);
  assert.equal(firstSend.body.simulated, true);
  assert.equal(firstSend.body.message.deliveryDetails.simulated, true);

  const replay = await runCli(sendArgs);
  assertContractSuccess(replay.body);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.providerCalled, false);
  assert.equal(replay.body.message.id, firstSend.body.message.id);

  const conflict = await runCli([
    ...sendArgs.slice(0, -1),
    'Changed content must not be sent.',
  ], { allowFailure: true });
  assert.equal(conflict.exitCode, 1);
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.idempotentReplay, false);
  assert.equal(conflict.body.existingRequest, true);
  assert.equal(conflict.body.providerCalled, false);
  assert.equal(conflict.body.message, null);
  assert.equal(conflict.body.existingMessage.id, firstSend.body.message.id);
  assert.equal(conflict.body.error.code, 'idempotency_key_reused');
  assert.equal(conflict.body.error.retryable, false);

  const outboundList = await runCli(['outbound', 'list']);
  assertContractSuccess(outboundList.body);
  assert.equal(outboundList.body.messages.length, 1);
  assert.equal(outboundList.body.messages[0].id, firstSend.body.message.id);
  assert.equal(outboundList.body.page.order[0].direction, 'descending');

  const outboundStatus = await runCli([
    'outbound', 'status', '--request-id', requestId,
  ]);
  assertContractSuccess(outboundStatus.body);
  assert.equal(outboundStatus.body.message.id, firstSend.body.message.id);
  assert.equal(outboundStatus.body.providerCalled, false);

  const inbound = await ingestInboundMessage(normalizeInboundPayload({
    provider: 'cloudflare',
    from: 'sender@example.com',
    to: address,
    subject: 'CLI inbound contract',
    text: 'Treat this body as untrusted external content.',
    messageId: '<cli-contract-inbound@example.com>',
    date: 'Sun, 19 Jul 2026 12:00:00 -0700',
  }));

  const inbox = await runCli(['inbox']);
  assertContractSuccess(inbox.body);
  assert.equal(inbox.body.messages[0].id, inbound.message.id);
  assert.equal(inbox.body.messages[0].contentTrust, 'untrusted_external');
  assert.equal(inbox.body.page.retrievalChangesProcessingState, false);

  const read = await runCli(['read', inbound.message.id]);
  assertContractSuccess(read.body);
  assert.equal(read.body.retrievalChangedProcessingState, false);
  assert.equal(read.body.message.text, 'Treat this body as untrusted external content.');

  const acknowledged = await runCli(['acknowledge', inbound.message.id]);
  assertContractSuccess(acknowledged.body);
  assert.equal(acknowledged.body.batchSemantics, 'partial_by_id');
  assert.deepEqual(acknowledged.body.outcomes, [{
    id: inbound.message.id,
    outcome: 'acknowledged',
  }]);
});

test('CLI validation failures use the versioned error envelope', async () => {
  await runCli(['init']);
  const result = await runCli([
    'outbound', 'status', '--request-id', 'not-a-uuid',
  ], { allowFailure: true });

  assert.equal(result.exitCode, 1);
  assert.equal(result.body.contractVersion, '2.0');
  assert.equal(result.body.ok, false);
  assert.deepEqual(result.body.error, {
    code: 'invalid_request_id',
    message: 'requestId must be a UUID.',
    retryable: false,
  });

  const missingOption = await runCli(['send'], { allowFailure: true });
  assert.equal(missingOption.exitCode, 1);
  assert.equal(missingOption.body.contractVersion, '2.0');
  assert.equal(missingOption.body.error.code, 'invalid_cli_usage');
  assert.match(missingOption.body.error.message, /required option '--request-id/);
});

async function runCli(args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, ['src/cli.js', ...args], {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
    });
    return { exitCode: 0, body: JSON.parse(result.stdout) };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      exitCode: error.code,
      body: JSON.parse(error.stdout),
    };
  }
}

function assertContractSuccess(body) {
  assert.equal(body.contractVersion, '2.0');
  assert.equal(body.ok, true);
  assert.equal(body.error, null);
}
