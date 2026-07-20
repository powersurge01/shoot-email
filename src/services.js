import crypto from 'node:crypto';
import { normalizeCustomAlias } from './aliasPolicy.js';
import {
  CONTRACT_VERSION,
  MESSAGE_BATCH_DEFAULTS,
  MESSAGE_BATCH_MAXIMUMS,
  OUTBOUND_CONSTRAINTS,
} from './contract.js';
import { getConfig } from './config.js';
import { createMailProvider } from './mailProviders.js';
import { readLocalConfig, writeLocalConfig } from './localConfig.js';
import {
  acknowledgeInboundMessages,
  changeUserEmailAlias,
  completeOutboundMessage,
  createInboundMessage,
  createUser,
  createUserIdentity,
  findOrCreateChatSession,
  findUserByIdentity,
  failOutboundMessage,
  getMessageForUser,
  getLatestOutboundAttempt,
  getOutboundMessageForUser,
  getOutboundUsageSnapshot,
  getUserByAlias,
  getUserById,
  listInboundMessages,
  listOutboundMessages,
  reactivateUserSending,
  recordInboundRelationship,
  reserveOutboundMessage,
  suspendUserSending,
  touchUserIdentity,
  updateUserAccountTier,
  updateUserSenderDisplayName,
} from './repositories.js';

export async function initMailbox() {
  const localConfig = await readLocalConfig();

  if (localConfig.userId) {
    const existingUser = await getUserById(localConfig.userId);
    if (existingUser) {
      return { user: existingUser, created: false };
    }
  }

  const alias = generateAlias();
  const user = await createUser(alias);
  await writeLocalConfig({ userId: user.id, emailAlias: user.email_alias });

  return { user, created: true };
}

export async function getCurrentUser() {
  const localConfig = await readLocalConfig();

  if (!localConfig.userId) {
    throw new Error('No local mailbox found. Run `shoot-email init` first.');
  }

  const user = await getUserById(localConfig.userId);
  if (!user) {
    throw new Error('Local mailbox user was not found in the database. Run `shoot-email init` again.');
  }

  return user;
}

async function resolveUser(userId) {
  if (!userId) {
    return getCurrentUser();
  }

  const user = await getUserById(userId);
  if (!user) {
    throw requestError('user_not_found', `User not found: ${userId}`);
  }
  return user;
}

export async function getSenderIdentity(userId) {
  const user = await resolveUser(userId);
  return serializeSenderIdentity(user);
}

export async function setSenderDisplayName(displayName) {
  const user = await getCurrentUser();
  const normalized = normalizeSenderDisplayName(displayName);
  const updated = await updateUserSenderDisplayName(user.id, normalized);
  return serializeSenderIdentity(updated);
}

export async function clearSenderDisplayName() {
  const user = await getCurrentUser();
  const updated = await updateUserSenderDisplayName(user.id, null);
  return serializeSenderIdentity(updated);
}

export async function setCustomEmailAlias(alias) {
  const user = await getCurrentUser();
  if (user.account_tier !== 'registered') {
    throw requestError(
      'registration_required',
      'A registered account is required to choose a custom alias.',
    );
  }

  const config = getConfig();
  const normalized = normalizeCustomAlias(alias, config.inboundDomain);
  const result = await changeUserEmailAlias({
    userId: user.id,
    newEmailAlias: normalized.email,
    cooldownDays: config.customAliasChangeCooldownDays,
  });
  if (result.rejected) {
    const error = requestError(result.code, result.message);
    if (result.retryAfter) error.retryAfter = result.retryAfter;
    throw error;
  }

  await writeLocalConfig({
    userId: result.user.id,
    emailAlias: result.user.email_alias,
  });
  return {
    ok: true,
    changed: result.changed,
    previousAddress: result.previousAlias,
    identity: serializeSenderIdentity(result.user).identity,
    alias: {
      localPart: normalized.localPart,
      cooldownDays: config.customAliasChangeCooldownDays,
      changedAt: result.user.email_alias_changed_at,
    },
  };
}

export async function sendEmail({
  userId,
  requestId,
  toEmail,
  subject,
  textBody,
  chatSessionId,
  mailProvider,
}) {
  validateOutboundRequest({ requestId, toEmail, subject, textBody });
  const normalizedRecipient = toEmail.trim().toLowerCase();

  const user = await resolveUser(userId);
  const config = getConfig();
  const provider = mailProvider || createMailProvider();
  const requestedSender = {
    fromEmail: user.email_alias,
    fromName: formatSenderName(user.sender_display_name),
  };
  const sender = provider.resolveSender
    ? provider.resolveSender(requestedSender)
    : { email: requestedSender.fromEmail, name: requestedSender.fromName };
  const reservation = await reserveOutboundMessage({
    userId: user.id,
    chatSessionId,
    clientRequestId: requestId,
    deliveryProvider: provider.name || 'unknown',
    fromEmail: sender.email,
    fromName: sender.name,
    toEmail: normalizedRecipient,
    subject,
    textBody,
    abusePolicy: config.outboundAbuse,
    enforceAbuseControls: provider.isTestProvider !== true,
  });

  if (!reservation.created) {
    const matchesOriginal = outboundContentMatches(reservation.message, {
      fromEmail: sender.email,
      fromName: sender.name,
      toEmail: normalizedRecipient,
      subject,
      textBody,
    });

    if (!matchesOriginal) {
      return serializeOutboundConflict(reservation.message);
    }

    return serializeOutboundResult(reservation.message, {
      idempotentReplay: true,
      providerCalled: false,
    });
  }

  if (reservation.rejected) {
    return serializeOutboundResult(reservation.message, {
      idempotentReplay: false,
      providerCalled: false,
    });
  }

  try {
    const sent = await provider.send({
      fromEmail: sender.email,
      fromName: sender.name,
      toEmail: normalizedRecipient,
      subject,
      textBody,
    });

    const message = await completeOutboundMessage({
      userId: user.id,
      messageId: reservation.message.id,
      providerMessageId: sent.providerMessageId,
      deliveryStatus: sent.deliveryStatus,
      deliveryDetails: sent.deliveryDetails,
      sentAt: sent.submittedAt,
    });

    if (!message) {
      throw new Error('Outbound message could not transition from submitting.');
    }

    return serializeOutboundResult(message, {
      idempotentReplay: false,
      providerCalled: true,
    });
  } catch (error) {
    const deliveryStatus = error.outcomeKnown ? 'failed' : 'unknown';
    const message = await failOutboundMessage({
      userId: user.id,
      messageId: reservation.message.id,
      deliveryStatus,
      errorCode: error.code || 'provider_error',
      errorMessage: error.message,
    });

    if (!message) {
      throw error;
    }

    return serializeOutboundResult(message, {
      idempotentReplay: false,
      providerCalled: true,
    });
  }
}

export async function listInbox(options = {}) {
  const { userId, ...batchOptions } = options;
  const user = await resolveUser(userId);
  return listInboundBatch({
    userId: user.id,
    processingStatus: 'pending',
    ...batchOptions,
  });
}

export async function listHistory(options = {}) {
  const { userId, ...batchOptions } = options;
  const user = await resolveUser(userId);
  return listInboundBatch({
    userId: user.id,
    processingStatus: 'processed',
    ...batchOptions,
  });
}

export async function listOutboundHistory(options = {}) {
  const {
    userId,
    limit = MESSAGE_BATCH_DEFAULTS.limit,
    maxChars = MESSAGE_BATCH_DEFAULTS.maxChars,
    maxMessageChars = MESSAGE_BATCH_DEFAULTS.maxMessageChars,
    cursor,
    includeBody = true,
  } = options;
  const user = await resolveUser(userId);
  validateBatchOptions({ limit, maxChars, maxMessageChars });

  const decodedCursor = decodeCursor(cursor, {
    resource: 'outbound',
    state: 'all',
  });
  const rows = await listOutboundMessages({
    userId: user.id,
    limit: limit + 1,
    beforeCreatedAt: decodedCursor?.createdAt,
    beforeId: decodedCursor?.id,
  });

  const { messages, returnedChars } = serializeOutboundBatchRows(rows, {
    limit,
    maxChars,
    maxMessageChars,
    includeBody,
  });
  const lastMessage = messages.at(-1);
  const hasMore = rows.length > messages.length;

  return {
    messages,
    returnedCount: messages.length,
    returnedChars,
    hasMore,
    nextCursor: hasMore && lastMessage
      ? encodeCursor({
          resource: 'outbound',
          state: 'all',
          createdAt: lastMessage.createdAt,
          id: lastMessage.id,
        })
      : null,
    page: batchPageMetadata('descending'),
  };
}

export async function getOutboundStatus({ userId, messageId, requestId }) {
  if ((messageId ? 1 : 0) + (requestId ? 1 : 0) !== 1) {
    throw requestError(
      'invalid_outbound_lookup',
      'Provide exactly one of messageId or requestId.',
    );
  }
  if (messageId) validateUuid(messageId, 'messageId', 'invalid_message_id');
  if (requestId) validateUuid(requestId, 'requestId', 'invalid_request_id');

  const user = await resolveUser(userId);
  const message = await getOutboundMessageForUser({
    userId: user.id,
    messageId,
    requestId,
  });
  if (!message) {
    throw requestError('outbound_message_not_found', 'Outbound message was not found.');
  }
  return {
    ok: true,
    statusLookup: true,
    providerCalled: false,
    simulated: message.delivery_provider === 'mock',
    message: serializeOutboundMessage(message),
    deliveryError: getOutboundStatusError(message),
  };
}

export async function acknowledgeMessages(messageIds, { userId } = {}) {
  const user = await resolveUser(userId);
  const uniqueIds = [...new Set(messageIds)];
  for (const id of uniqueIds) {
    validateUuid(id, 'messageId', 'invalid_message_id');
  }
  const result = await acknowledgeInboundMessages(user.id, uniqueIds);
  const updated = new Set(result.updatedIds);
  const existing = new Map(result.existing.map((message) => [message.id, message]));

  const acknowledged = uniqueIds.filter((id) => updated.has(id));
  const alreadyProcessed = uniqueIds.filter(
      (id) => !updated.has(id) && existing.get(id)?.processing_status === 'processed',
    );
  const notFound = uniqueIds.filter((id) => !existing.has(id));

  return {
    ok: true,
    idempotent: true,
    batchSemantics: 'partial_by_id',
    allSucceeded: notFound.length === 0,
    requestedCount: uniqueIds.length,
    successfulCount: uniqueIds.length - notFound.length,
    acknowledged,
    alreadyProcessed,
    notFound,
    outcomes: uniqueIds.map((id) => ({
      id,
      outcome: acknowledged.includes(id)
        ? 'acknowledged'
        : alreadyProcessed.includes(id)
          ? 'already_processed'
          : 'not_found',
    })),
  };
}

export async function readMessage(messageId, { userId } = {}) {
  validateUuid(messageId, 'messageId', 'invalid_message_id');
  const user = await resolveUser(userId);
  const message = await getMessageForUser(user.id, messageId);

  if (!message) {
    throw requestError('message_not_found', `Message not found: ${messageId}`);
  }

  return {
    ok: true,
    retrievalChangedProcessingState: false,
    message: serializeStoredMessage(message),
  };
}

export async function ingestInboundMessage(normalizedMessage) {
  const user = await getUserByAlias(normalizedMessage.toEmail);

  if (!user) {
    return { stored: false, reason: 'unknown_recipient' };
  }

  const result = await createInboundMessage({
    userId: user.id,
    fromEmail: normalizedMessage.fromEmail,
    toEmail: normalizedMessage.toEmail,
    subject: normalizedMessage.subject,
    textBody: normalizedMessage.textBody,
    providerMessageId: normalizedMessage.providerMessageId,
    receivedAt: normalizedMessage.receivedAt,
  });

  await recordInboundRelationship({
    userId: user.id,
    senderEmail: normalizedMessage.fromEmail,
    receivedAt: normalizedMessage.receivedAt,
  });

  return {
    stored: result.created,
    reason: result.created ? undefined : 'duplicate',
    user,
    message: result.message,
  };
}

export async function getAbuseStatus(userId) {
  const user = userId ? await getUserById(userId) : await getCurrentUser();
  if (!user) {
    throw requestError('user_not_found', `User not found: ${userId}`);
  }

  const config = getConfig();
  const usage = await getOutboundUsageSnapshot(user.id);
  return {
    ok: true,
    outboundEnabled: config.outboundAbuse.enabled,
    user: serializeAbuseUser(user),
    limits: {
      global: config.outboundAbuse.global,
      user: config.outboundAbuse[user.account_tier],
    },
    usage: usage.map((row) => ({
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      bucketType: row.bucket_type,
      bucketStart: row.bucket_start,
      used: row.used_count,
    })),
  };
}

export async function getServiceStatus(userId, { chatSessionId } = {}) {
  const user = await resolveUser(userId);
  const config = getConfig();
  const provider = createMailProvider();
  const usageRows = await getOutboundUsageSnapshot(user.id, chatSessionId);
  const latestAttempt = await getLatestOutboundAttempt(user.id);
  const tierLimits = config.outboundAbuse[user.account_tier];
  const usage = usageMap(usageRows);
  const providerConfigured = provider.isTestProvider === true || Boolean(
    config.cloudflareAccountId
      && config.cloudflareApiToken
      && (config.cloudflareFromEmail || user.email_alias),
  );
  const outboundEnabled = provider.isTestProvider === true
    || config.outboundAbuse.enabled;

  return {
    ok: true,
    service: {
      name: 'shoot-email',
      version: '0.1.0',
      contractVersion: CONTRACT_VERSION,
      environment: config.environment,
      serverTime: new Date().toISOString(),
    },
    provider: {
      name: provider.name || config.mailProvider,
      mode: provider.isTestProvider === true ? 'simulation' : 'production',
      simulated: provider.isTestProvider === true,
      configured: providerConfigured,
    },
    outbound: {
      enabled: outboundEnabled,
      available: outboundEnabled
        && user.sending_status === 'active'
        && providerConfigured,
      abuseControlsEnforced: provider.isTestProvider !== true,
      sendingStatus: user.sending_status,
      suspensionReason: user.sending_suspension_reason,
      latestAttemptAt: latestAttempt,
    },
    identity: serializeSenderIdentity(user).identity,
    account: {
      tier: user.account_tier,
    },
    quotas: {
      globalHourly: quotaStatus(
        usage.get('global:hour'),
        config.outboundAbuse.global.hourlyLimit,
        'hour',
      ),
      globalDaily: quotaStatus(
        usage.get('global:day'),
        config.outboundAbuse.global.dailyLimit,
        'day',
      ),
      userHourly: quotaStatus(
        usage.get('user:hour'),
        tierLimits.hourlyLimit,
        'hour',
      ),
      userDaily: quotaStatus(
        usage.get('user:day'),
        tierLimits.dailyLimit,
        'day',
      ),
      newRecipientsDaily: quotaStatus(
        usage.get('user_new_recipient:day'),
        tierLimits.newRecipientDailyLimit,
        'day',
      ),
      sessionHourly: chatSessionId
        ? quotaStatus(
            usage.get('session:hour'),
            tierLimits.sessionHourlyLimit,
            'hour',
          )
        : null,
      minimumIntervalSeconds: tierLimits.minimumIntervalSeconds,
    },
    constraints: {
      outbound: OUTBOUND_CONSTRAINTS,
      retrieval: {
        defaults: MESSAGE_BATCH_DEFAULTS,
        maximums: MESSAGE_BATCH_MAXIMUMS,
      },
    },
  };
}

export async function setAccountTier(userId, accountTier) {
  if (!['guest', 'registered'].includes(accountTier)) {
    throw requestError('invalid_account_tier', 'tier must be guest or registered.');
  }
  const user = await updateUserAccountTier(userId, accountTier);
  if (!user) {
    throw requestError('user_not_found', `User not found: ${userId}`);
  }
  return { ok: true, user: serializeAbuseUser(user) };
}

export async function suspendSending(userId, reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized || normalized.length > 500) {
    throw requestError(
      'invalid_suspension_reason',
      'reason must contain 1 to 500 characters.',
    );
  }
  const user = await suspendUserSending(userId, normalized);
  if (!user) {
    throw requestError('user_not_found', `User not found: ${userId}`);
  }
  return { ok: true, user: serializeAbuseUser(user) };
}

export async function reactivateSending(userId) {
  const user = await reactivateUserSending(userId);
  if (!user) {
    throw requestError('user_not_found', `User not found: ${userId}`);
  }
  return { ok: true, user: serializeAbuseUser(user) };
}

export async function findOrCreateOpenAiContext({
  subject,
  session,
  organization,
}) {
  if (!subject) {
    throw new Error('OpenAI subject is required to resolve an app user.');
  }

  const provider = 'openai_apps';
  let userCreated = false;
  let user = await findUserByIdentity({
    provider,
    providerSubject: subject,
    providerOrganization: organization,
  });

  if (user) {
    await touchUserIdentity({
      provider,
      providerSubject: subject,
      providerOrganization: organization,
    });
  } else {
    user = await createUser(generateAlias());
    userCreated = true;
    await createUserIdentity({
      userId: user.id,
      provider,
      providerSubject: subject,
      providerOrganization: organization,
    });
  }

  const chatSession = session
    ? await findOrCreateChatSession({
        userId: user.id,
        provider,
        providerSession: session,
        providerSubject: subject,
      })
    : null;

  return { user, chatSession, userCreated };
}

export async function findOpenAiContext({
  subject,
  session,
  organization,
}) {
  if (!subject) {
    throw requestError(
      'missing_openai_subject',
      'OpenAI subject is required to resolve an app user.',
    );
  }

  const provider = 'openai_apps';
  const user = await findUserByIdentity({
    provider,
    providerSubject: subject,
    providerOrganization: organization,
  });
  if (!user) return null;

  await touchUserIdentity({
    provider,
    providerSubject: subject,
    providerOrganization: organization,
  });
  const chatSession = session
    ? await findOrCreateChatSession({
        userId: user.id,
        provider,
        providerSession: session,
        providerSubject: subject,
      })
    : null;

  return { user, chatSession, userCreated: false };
}

function generateAlias() {
  const config = getConfig();
  const token = crypto.randomBytes(4).toString('hex');
  return `u_${token}@${config.inboundDomain}`;
}

async function listInboundBatch({
  userId,
  processingStatus,
  limit = MESSAGE_BATCH_DEFAULTS.limit,
  maxChars = MESSAGE_BATCH_DEFAULTS.maxChars,
  maxMessageChars = MESSAGE_BATCH_DEFAULTS.maxMessageChars,
  cursor,
  includeBody = true,
}) {
  validateBatchOptions({ limit, maxChars, maxMessageChars });

  const decodedCursor = decodeCursor(cursor, {
    resource: 'inbound',
    state: processingStatus,
  });
  const rows = await listInboundMessages({
    userId,
    processingStatus,
    limit: limit + 1,
    afterCreatedAt: decodedCursor?.createdAt,
    afterId: decodedCursor?.id,
  });

  const messages = [];
  let returnedChars = 0;

  for (const row of rows.slice(0, limit)) {
    const originalBody = row.text_body || '';
    const originalBodyChars = countCharacters(originalBody);
    const availableChars = Math.max(0, maxChars - returnedChars);
    const bodyLimit = includeBody
      ? Math.min(maxMessageChars, availableChars)
      : 0;

    if (includeBody && bodyLimit === 0) {
      break;
    }

    const text = includeBody ? takeCharacters(originalBody, bodyLimit) : undefined;
    const returnedBodyChars = includeBody ? countCharacters(text) : 0;

    messages.push({
      id: row.id,
      from: row.from_email,
      fromName: row.from_name || null,
      to: [row.to_email],
      subject: row.subject,
      ...(includeBody ? { text } : {}),
      receivedAt: row.received_at,
      createdAt: row.created_at,
      processingStatus: row.processing_status,
      providerMessageId: row.provider_message_id,
      contentTrust: 'untrusted_external',
      bodyTruncated: includeBody && returnedBodyChars < originalBodyChars,
      originalBodyChars,
      returnedBodyChars,
    });

    returnedChars += returnedBodyChars;
  }

  const lastMessage = messages.at(-1);
  const hasMore = rows.length > messages.length;

  return {
    messages,
    returnedCount: messages.length,
    returnedChars,
    hasMore,
    nextCursor:
      hasMore && lastMessage
        ? encodeCursor({
            resource: 'inbound',
            state: processingStatus,
            createdAt: lastMessage.createdAt,
            id: lastMessage.id,
          })
        : null,
    page: batchPageMetadata('ascending'),
  };
}

function validateBatchOptions({ limit, maxChars, maxMessageChars }) {
  validateBatchOption('limit', limit, MESSAGE_BATCH_MAXIMUMS.limit);
  validateBatchOption('maxChars', maxChars, MESSAGE_BATCH_MAXIMUMS.maxChars);
  validateBatchOption(
    'maxMessageChars',
    maxMessageChars,
    MESSAGE_BATCH_MAXIMUMS.maxMessageChars,
  );
}

function validateBatchOption(name, value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    const code = `invalid_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
    throw requestError(code, `${name} must be an integer between 1 and ${maximum}.`);
  }
}

function encodeCursor({ resource, state, createdAt, id }) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      resource,
      state,
      createdAt: new Date(createdAt).toISOString(),
      id,
    }),
  ).toString('base64url');
}

function decodeCursor(cursor, expected) {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      decoded.version !== 1 ||
      decoded.resource !== expected.resource ||
      decoded.state !== expected.state ||
      typeof decoded.id !== 'string' ||
      !isUuid(decoded.id) ||
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt))
    ) {
      throw new Error('invalid cursor fields');
    }
    return decoded;
  } catch {
    throw requestError(
      'invalid_cursor',
      `Invalid cursor for ${expected.resource}/${expected.state}.`,
    );
  }
}

function batchPageMetadata(direction) {
  return {
    order: [{ field: 'createdAt', direction }, { field: 'id', direction }],
    cursorVersion: 1,
    snapshot: false,
    cursorExpiresAt: null,
    retrievalChangesProcessingState: false,
    consistency: {
      mode: 'live_keyset',
      guarantee:
        'The cursor is not a snapshot. Newer arrivals may appear on later pages; messages whose processing state changes may disappear from later pages.',
      duplicateRiskFromNewArrivals: false,
      omissionRiskFromStateChanges: true,
    },
    defaults: MESSAGE_BATCH_DEFAULTS,
    maximums: MESSAGE_BATCH_MAXIMUMS,
  };
}

function countCharacters(value) {
  return Array.from(value).length;
}

function takeCharacters(value, limit) {
  return Array.from(value).slice(0, limit).join('');
}

function validateOutboundRequest({ requestId, toEmail, subject, textBody }) {
  validateUuid(requestId, 'requestId', 'invalid_request_id');

  if (
    typeof toEmail !== 'string' ||
    toEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)
  ) {
    throw requestError('invalid_recipient', 'A valid recipient email address is required.');
  }

  const subjectChars = typeof subject === 'string' ? countCharacters(subject) : 0;
  if (subjectChars < 1 || subjectChars > OUTBOUND_CONSTRAINTS.subjectMaxChars) {
    throw requestError(
      'invalid_subject',
      `subject must contain 1 to ${OUTBOUND_CONSTRAINTS.subjectMaxChars} characters.`,
    );
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(subject)) {
    throw requestError(
      'invalid_subject',
      'subject cannot contain line breaks or control characters.',
    );
  }

  const bodyChars = typeof textBody === 'string' ? countCharacters(textBody) : 0;
  if (bodyChars < 1 || bodyChars > OUTBOUND_CONSTRAINTS.textMaxChars) {
    throw requestError(
      'invalid_text',
      `text must contain 1 to ${OUTBOUND_CONSTRAINTS.textMaxChars.toLocaleString('en-US')} characters.`,
    );
  }
}

function validateUuid(value, fieldName, code) {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw requestError(code, `${fieldName} must be a UUID.`);
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function outboundContentMatches(
  message,
  { fromEmail, fromName, toEmail, subject, textBody },
) {
  return (
    message.from_email === fromEmail &&
    message.from_name === fromName &&
    message.to_email === toEmail &&
    message.subject === subject &&
    message.text_body === textBody
  );
}

function serializeOutboundResult(message, {
  idempotentReplay,
  providerCalled,
}) {
  const successful = ['queued', 'delivered'].includes(message.delivery_status);
  const error = getOutboundStatusError(message);

  return {
    ok: successful,
    idempotentReplay,
    existingRequest: idempotentReplay,
    providerCalled,
    simulated: message.delivery_provider === 'mock',
    message: serializeOutboundMessage(message),
    error,
  };
}

function serializeOutboundConflict(message) {
  return {
    ok: false,
    idempotentReplay: false,
    existingRequest: true,
    providerCalled: false,
    simulated: message.delivery_provider === 'mock',
    message: null,
    existingMessage: serializeOutboundMessage(message),
    error: {
      code: 'idempotency_key_reused',
      message: 'The request ID is already associated with different email content.',
      retryable: false,
    },
  };
}

function serializeOutboundMessage(message, { includeText = true } = {}) {
  return {
    id: message.id,
    direction: 'outbound',
    requestId: message.client_request_id,
    provider: message.delivery_provider,
    simulated: message.delivery_provider === 'mock',
    providerMessageId: message.provider_message_id,
    from: {
      address: message.from_email,
      name: message.from_name || null,
    },
    to: [message.to_email],
    subject: message.subject,
    ...(includeText ? { text: message.text_body } : {}),
    deliveryStatus: message.delivery_status,
    deliveryDetails: message.delivery_details || {},
    deliveryError: getOutboundStatusError(message),
    createdAt: message.created_at,
    providerAttemptedAt: message.last_send_attempt_at,
    providerResultAt: message.sent_at,
  };
}

function serializeOutboundBatchRows(rows, {
  limit,
  maxChars,
  maxMessageChars,
  includeBody,
}) {
  const messages = [];
  let returnedChars = 0;
  for (const row of rows.slice(0, limit)) {
    const originalBody = row.text_body || '';
    const originalBodyChars = countCharacters(originalBody);
    const availableChars = Math.max(0, maxChars - returnedChars);
    const bodyLimit = includeBody ? Math.min(maxMessageChars, availableChars) : 0;
    if (includeBody && bodyLimit === 0) break;
    const text = includeBody ? takeCharacters(originalBody, bodyLimit) : undefined;
    const returnedBodyChars = includeBody ? countCharacters(text) : 0;
    messages.push({
      ...serializeOutboundMessage(row, { includeText: false }),
      ...(includeBody ? { text } : {}),
      bodyTruncated: includeBody && returnedBodyChars < originalBodyChars,
      originalBodyChars,
      returnedBodyChars,
    });
    returnedChars += returnedBodyChars;
  }
  return { messages, returnedChars };
}

function serializeStoredMessage(message) {
  if (message.direction === 'outbound') {
    return serializeOutboundMessage(message);
  }
  return {
    id: message.id,
    direction: 'inbound',
    from: {
      address: message.from_email,
      name: message.from_name || null,
    },
    to: [message.to_email],
    subject: message.subject,
    text: message.text_body,
    providerMessageId: message.provider_message_id,
    receivedAt: message.received_at,
    createdAt: message.created_at,
    processingStatus: message.processing_status,
    processedAt: message.processed_at,
    contentTrust: 'untrusted_external',
  };
}

function normalizeSenderDisplayName(value) {
  if (typeof value !== 'string') {
    throw requestError('invalid_display_name', 'displayName must be a string.');
  }

  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw requestError(
      'invalid_display_name',
      'displayName cannot contain line breaks or control characters.',
    );
  }

  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (countCharacters(normalized) < 1 || countCharacters(normalized) > 80) {
    throw requestError(
      'invalid_display_name',
      'displayName must contain 1 to 80 characters.',
    );
  }

  if (normalized.includes('@') || /[<>]/.test(normalized)) {
    throw requestError(
      'invalid_display_name',
      'displayName must be a name, not an email address or header value.',
    );
  }

  return normalized;
}

function formatSenderName(senderDisplayName) {
  if (!senderDisplayName || senderDisplayName.toLowerCase() === 'shoot email') {
    return 'Shoot Email';
  }
  return `${senderDisplayName} via Shoot Email`;
}

function serializeSenderIdentity(user) {
  const name = formatSenderName(user.sender_display_name);
  return {
    ok: true,
    identity: {
      address: user.email_alias,
      displayName: user.sender_display_name,
      senderName: name,
      formatted: `${name} <${user.email_alias}>`,
    },
  };
}

function serializeAbuseUser(user) {
  return {
    id: user.id,
    emailAlias: user.email_alias,
    accountTier: user.account_tier,
    sendingStatus: user.sending_status,
    suspendedAt: user.sending_suspended_at,
    suspensionReason: user.sending_suspension_reason,
  };
}

function usageMap(rows) {
  return new Map(rows.map((row) => [
    `${row.scope_type}:${row.bucket_type}`,
    row,
  ]));
}

function quotaStatus(row, limit, bucketType) {
  const used = row?.used_count || 0;
  const bucketStart = row?.bucket_start
    ? new Date(row.bucket_start)
    : startOfCurrentUtcBucket(bucketType);
  const resetAt = new Date(bucketStart);
  if (bucketType === 'hour') resetAt.setUTCHours(resetAt.getUTCHours() + 1);
  else resetAt.setUTCDate(resetAt.getUTCDate() + 1);

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: resetAt.toISOString(),
  };
}

function startOfCurrentUtcBucket(bucketType) {
  const date = new Date();
  if (bucketType === 'hour') date.setUTCMinutes(0, 0, 0);
  else date.setUTCHours(0, 0, 0, 0);
  return date;
}

function getOutboundStatusError(message) {
  if (message.delivery_status === 'submitting') {
    return {
      code: 'request_in_progress',
      message: 'The original send request is still in progress; it was not sent again.',
      retryable: true,
    };
  }

  if (message.delivery_status === 'permanent_bounce') {
    return {
      code: 'permanent_bounce',
      message: 'The provider reported a permanent bounce for the recipient.',
      retryable: false,
    };
  }

  if (message.delivery_status === 'failed') {
    return {
      code: message.delivery_error_code || 'provider_rejected',
      message: message.delivery_error_message || 'The provider rejected the send request.',
      retryable: false,
    };
  }

  if (message.delivery_status === 'unknown') {
    return {
      code: message.delivery_error_code || 'delivery_outcome_unknown',
      message:
        message.delivery_error_message ||
        'The delivery outcome is unknown; the message was not sent again.',
      retryable: false,
      guidance:
        'Do not create a new request ID automatically. Query this request for a later status update.',
    };
  }

  if (message.delivery_status === 'rejected') {
    const abuse = message.delivery_details?.abuse || {};
    return {
      code: message.delivery_error_code || 'send_rejected',
      message: message.delivery_error_message || 'The send request was rejected.',
      retryable: Boolean(abuse.retryAfter),
      ...(abuse.limitType ? { limitType: abuse.limitType } : {}),
      ...(abuse.retryAfter ? { retryAt: abuse.retryAfter } : {}),
    };
  }

  return null;
}
