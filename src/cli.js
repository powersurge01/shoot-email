#!/usr/bin/env node
import { Command } from 'commander';
import { contractError, withContract } from './contract.js';
import { closePool } from './db.js';
import { getLocalConfigPath } from './localConfig.js';
import { formatMessage, formatMessageRow } from './formatters.js';
import { migrate } from './migrate.js';
import {
  acknowledgeMessages,
  clearSenderDisplayName,
  getAbuseStatus,
  getCurrentUser,
  getOutboundStatus,
  getSenderIdentity,
  getServiceStatus,
  initMailbox,
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
} from './services.js';

const program = new Command();
let commanderErrorOutput = '';

program
  .name('shoot-email')
  .description('Terminal-first email client/service prototype')
  .version('0.1.0');

program
  .configureOutput({
    writeErr: (value) => {
      commanderErrorOutput += value;
    },
  })
  .exitOverride();

program
  .command('migrate')
  .description('Apply database migrations')
  .action(run(async () => {
    await migrate();
    console.log('Database is up to date.');
  }));

program
  .command('init')
  .description('Create or reuse the local mailbox identity')
  .action(runJson(async () => {
    const { user, created } = await initMailbox();
    return {
      created,
      mailbox: {
        userId: user.id,
        address: user.email_alias,
        configPath: getLocalConfigPath(),
      },
    };
  }));

program
  .command('address')
  .description('Return the current mailbox address as structured JSON')
  .action(runJson(async () => {
    const user = await getCurrentUser();
    return { address: user.email_alias };
  }));

program
  .command('status')
  .description('Read provider mode, sender identity, availability, quotas, and limits')
  .action(runJson(async () => getServiceStatus()));

const identity = program
  .command('identity')
  .description('Manage the stable sender identity');

identity
  .command('show')
  .description('Return the current sender identity as structured JSON')
  .action(runJson(async () => getSenderIdentity()));

identity
  .command('set')
  .description('Set the user-controlled sender display name')
  .requiredOption('--display-name <name>', 'name shown before "via Shoot Email"')
  .action(runJson(async (options) => setSenderDisplayName(options.displayName)));

identity
  .command('clear')
  .description('Return to the default Shoot Email sender name')
  .action(runJson(async () => clearSenderDisplayName()));

const alias = identity
  .command('alias')
  .description('Manage the registered account custom email alias');

alias
  .command('set')
  .description('Claim a custom alias while retaining old addresses for inbound mail')
  .requiredOption('--alias <local-part>', '3-32 characters before the @ sign')
  .action(runJson(async (options) => setCustomEmailAlias(options.alias)));

const abuse = program
  .command('abuse')
  .description('Inspect and administer outbound abuse controls');

abuse
  .command('status')
  .description('Return current limits, usage, tier, and sending status')
  .argument('[user-id]', 'internal user ID; defaults to the local mailbox')
  .action(runJson(async (userId) => getAbuseStatus(userId)));

abuse
  .command('tier')
  .description('Set the account tier without resetting quota usage')
  .argument('<user-id>', 'internal user ID')
  .requiredOption('--tier <tier>', 'guest or registered')
  .action(runJson(async (userId, options) => setAccountTier(userId, options.tier)));

abuse
  .command('suspend')
  .description('Suspend outbound sending for a user')
  .argument('<user-id>', 'internal user ID')
  .requiredOption('--reason <reason>', 'operator-visible suspension reason')
  .action(runJson(async (userId, options) => suspendSending(userId, options.reason)));

abuse
  .command('reactivate')
  .description('Reactivate outbound sending for a user')
  .argument('<user-id>', 'internal user ID')
  .action(runJson(async (userId) => reactivateSending(userId)));

program
  .command('send')
  .description('Submit one idempotent plain-text email and return structured JSON')
  .requiredOption('--request-id <uuid>', 'stable UUID reused when retrying this send')
  .requiredOption('--to <email>', 'single recipient email address')
  .requiredOption('--subject <subject>', 'email subject (1-200 characters)')
  .requiredOption('--text <text>', 'plain text body (1-20,000 characters)')
  .action(runJson(async (options) => {
    return sendEmail({
      requestId: options.requestId,
      toEmail: options.to,
      subject: options.subject,
      textBody: options.text,
    });
  }));

program
  .command('inbox')
  .description('Return pending inbound messages as structured JSON')
  .option('--limit <number>', 'maximum messages (default 50, maximum 200)', parsePositiveInt, 50)
  .option('--max-chars <number>', 'total body budget (default 100000, maximum 500000)', parsePositiveInt, 100000)
  .option('--max-message-chars <number>', 'per-body budget (default 16000, maximum 100000)', parsePositiveInt, 16000)
  .option('--cursor <cursor>', 'opaque cursor from a previous inbox response')
  .option('--compact', 'print a compact human-readable list')
  .action(run(async (options) => {
    const result = await listInbox({
      limit: options.limit,
      maxChars: options.maxChars,
      maxMessageChars: options.maxMessageChars,
      cursor: options.cursor,
      includeBody: !options.compact,
    });

    if (options.compact) {
      for (const message of result.messages) {
        console.log(formatMessageRow({
          id: message.id,
          received_at: message.receivedAt,
          created_at: message.createdAt,
          from_email: message.from,
          subject: message.subject,
        }));
      }
      return;
    }

    printJson(result);
  }));

program
  .command('acknowledge')
  .alias('ack')
  .description('Idempotently process IDs; unknown IDs are reported without blocking valid IDs')
  .argument('<message-ids...>', 'one or more message IDs')
  .action(run(async (messageIds) => {
    printJson(await acknowledgeMessages(messageIds));
  }));

program
  .command('history')
  .description('Return processed inbound messages; retrieval never changes processing state')
  .option('--limit <number>', 'maximum messages (default 50, maximum 200)', parsePositiveInt, 50)
  .option('--max-chars <number>', 'total body budget (default 100000, maximum 500000)', parsePositiveInt, 100000)
  .option('--max-message-chars <number>', 'per-body budget (default 16000, maximum 100000)', parsePositiveInt, 16000)
  .option('--cursor <cursor>', 'opaque cursor from a previous history response')
  .option('--compact', 'print a compact human-readable list')
  .action(run(async (options) => {
    const result = await listHistory({
      limit: options.limit,
      maxChars: options.maxChars,
      maxMessageChars: options.maxMessageChars,
      cursor: options.cursor,
      includeBody: !options.compact,
    });

    if (options.compact) {
      for (const message of result.messages) {
        console.log(formatMessageRow({
          id: message.id,
          received_at: message.receivedAt,
          created_at: message.createdAt,
          from_email: message.from,
          subject: message.subject,
        }));
      }
      return;
    }

    printJson(result);
  }));

const outbound = program
  .command('outbound')
  .description('Query persisted outbound messages without sending');

outbound
  .command('list')
  .description('Return outbound history newest first as structured JSON')
  .option('--limit <number>', 'maximum messages (default 50, maximum 200)', parsePositiveInt, 50)
  .option('--max-chars <number>', 'total body budget (default 100000, maximum 500000)', parsePositiveInt, 100000)
  .option('--max-message-chars <number>', 'per-body budget (default 16000, maximum 100000)', parsePositiveInt, 16000)
  .option('--cursor <cursor>', 'opaque cursor from a previous outbound list response')
  .option('--compact', 'omit bodies while retaining structured JSON')
  .action(runJson(async (options) => listOutboundHistory({
    limit: options.limit,
    maxChars: options.maxChars,
    maxMessageChars: options.maxMessageChars,
    cursor: options.cursor,
    includeBody: !options.compact,
  })));

outbound
  .command('status')
  .description('Return a persisted delivery result without resending')
  .option('--message-id <uuid>', 'internal outbound message ID')
  .option('--request-id <uuid>', 'caller-generated send request ID')
  .action(runJson(async (options) => getOutboundStatus({
    messageId: options.messageId,
    requestId: options.requestId,
  })));

program
  .command('read')
  .alias('get-message')
  .description('Return one message as structured JSON without acknowledging it')
  .argument('<message-id>', 'message ID')
  .option('--compact', 'print a human-readable message')
  .action(run(async (messageId, options) => {
    const result = await readMessage(messageId);
    if (options.compact) {
      console.log(formatMessage(toFormatterMessage(result.message)));
      return;
    }
    printJson(result);
  }));

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Expected a positive integer.');
  }

  return parsed;
}

function toFormatterMessage(message) {
  return {
    id: message.id,
    direction: message.direction,
    from_email: message.from.address,
    to_email: message.to[0],
    subject: message.subject,
    text_body: message.text,
    received_at: message.receivedAt,
    sent_at: message.providerResultAt,
    created_at: message.createdAt,
  };
}

function printJson(result) {
  console.log(JSON.stringify(withContract(result), null, 2));
}

function run(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      console.log(JSON.stringify(contractError(error), null, 2));
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  };
}

function runJson(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      printJson(result);
      if (result?.ok === false) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.log(JSON.stringify(contractError(error), null, 2));
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  };
}

try {
  await program.parseAsync();
} catch (error) {
  if (error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const message = commanderErrorOutput
      .trim()
      .replace(/^error:\s*/i, '') || error.message;
    console.log(JSON.stringify(contractError({
      code: 'invalid_cli_usage',
      message,
      retryable: false,
    }), null, 2));
    process.exitCode = error.exitCode || 1;
  }
  await closePool();
}
