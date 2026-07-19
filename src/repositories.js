import crypto from 'node:crypto';
import { query, transaction } from './db.js';

const USER_SELECT = `
  id,
  email_alias,
  sender_display_name,
  account_tier,
  sending_status,
  sending_suspended_at,
  sending_suspension_reason,
  email_alias_changed_at,
  created_at
`;

const QUALIFIED_USER_SELECT = `
  users.id,
  users.email_alias,
  users.sender_display_name,
  users.account_tier,
  users.sending_status,
  users.sending_suspended_at,
  users.sending_suspension_reason,
  users.email_alias_changed_at,
  users.created_at
`;

export async function createUser(emailAlias) {
  const id = crypto.randomUUID();
  return transaction(async (txQuery) => {
    const result = await txQuery(
      `
        INSERT INTO users (id, email_alias)
        VALUES ($1, $2)
        RETURNING ${USER_SELECT}
      `,
      [id, emailAlias.toLowerCase()],
    );
    await txQuery(
      `
        INSERT INTO user_email_aliases (email_alias, user_id, status)
        VALUES ($1, $2, 'current')
      `,
      [emailAlias.toLowerCase(), id],
    );
    return result.rows[0];
  });
}

export async function getUserById(id) {
  const result = await query(
    `SELECT ${USER_SELECT} FROM users WHERE id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

export async function getUserByAlias(emailAlias) {
  const result = await query(
    `
      SELECT ${QUALIFIED_USER_SELECT}
      FROM user_email_aliases
      JOIN users ON users.id = user_email_aliases.user_id
      WHERE user_email_aliases.email_alias = lower($1)
    `,
    [emailAlias],
  );

  return result.rows[0] || null;
}

export async function findUserByIdentity({
  provider,
  providerSubject,
  providerOrganization,
}) {
  const result = await query(
    `
      SELECT ${QUALIFIED_USER_SELECT}
      FROM user_identities
      JOIN users ON users.id = user_identities.user_id
      WHERE user_identities.provider = $1
        AND user_identities.provider_subject = $2
        AND user_identities.provider_organization IS NOT DISTINCT FROM $3
    `,
    [provider, providerSubject, providerOrganization || null],
  );

  return result.rows[0] || null;
}

export async function createUserIdentity({
  userId,
  provider,
  providerSubject,
  providerOrganization,
}) {
  const id = crypto.randomUUID();
  const result = await query(
    `
      INSERT INTO user_identities (
        id,
        user_id,
        provider,
        provider_subject,
        provider_organization
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, provider_subject, provider_organization)
        DO UPDATE SET last_seen_at = now()
      RETURNING *
    `,
    [id, userId, provider, providerSubject, providerOrganization || null],
  );

  return result.rows[0];
}

export async function updateUserSenderDisplayName(userId, senderDisplayName) {
  const result = await query(
    `
      UPDATE users
      SET sender_display_name = $2
      WHERE id = $1
      RETURNING ${USER_SELECT}
    `,
    [userId, senderDisplayName],
  );

  return result.rows[0] || null;
}

export async function changeUserEmailAlias({
  userId,
  newEmailAlias,
  cooldownDays,
}) {
  try {
    return await transaction(async (txQuery) => {
      const userResult = await txQuery(
        `SELECT ${USER_SELECT} FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) {
        return { rejected: true, code: 'user_not_found', message: 'User was not found.' };
      }
      if (user.email_alias === newEmailAlias) {
        return { user, changed: false, previousAlias: user.email_alias };
      }
      if (user.account_tier !== 'registered') {
        return {
          rejected: true,
          code: 'registration_required',
          message: 'A registered account is required to choose a custom alias.',
        };
      }

      const clock = await txQuery('SELECT transaction_timestamp() AS now');
      const now = new Date(clock.rows[0].now);
      if (user.email_alias_changed_at) {
        const retryAfter = new Date(
          new Date(user.email_alias_changed_at).getTime()
            + cooldownDays * 24 * 60 * 60 * 1000,
        );
        if (retryAfter > now) {
          return {
            rejected: true,
            code: 'alias_change_cooldown',
            message: 'The custom alias can only be changed after the cooldown period.',
            retryAfter: retryAfter.toISOString(),
          };
        }
      }

      const existing = await txQuery(
        'SELECT 1 FROM user_email_aliases WHERE email_alias = $1',
        [newEmailAlias],
      );
      if (existing.rowCount > 0) {
        return {
          rejected: true,
          code: 'alias_unavailable',
          message: 'That alias has already been used and cannot be claimed.',
        };
      }

      const retired = await txQuery(
        `
          UPDATE user_email_aliases
          SET status = 'retired', retired_at = $2
          WHERE user_id = $1 AND status = 'current'
        `,
        [userId, now],
      );
      if (retired.rowCount !== 1) {
        throw new Error('The user did not have exactly one current email alias.');
      }

      await txQuery(
        `
          INSERT INTO user_email_aliases (email_alias, user_id, status)
          VALUES ($1, $2, 'current')
        `,
        [newEmailAlias, userId],
      );
      const updated = await txQuery(
        `
          UPDATE users
          SET email_alias = $2,
              email_alias_changed_at = $3
          WHERE id = $1
          RETURNING ${USER_SELECT}
        `,
        [userId, newEmailAlias, now],
      );
      return {
        user: updated.rows[0],
        changed: true,
        previousAlias: user.email_alias,
      };
    });
  } catch (error) {
    if (error.code === '23505') {
      const conflict = new Error('That alias has already been used and cannot be claimed.');
      conflict.code = 'alias_unavailable';
      throw conflict;
    }
    throw error;
  }
}

export async function touchUserIdentity({
  provider,
  providerSubject,
  providerOrganization,
}) {
  const result = await query(
    `
      UPDATE user_identities
      SET last_seen_at = now()
      WHERE provider = $1
        AND provider_subject = $2
        AND provider_organization IS NOT DISTINCT FROM $3
      RETURNING *
    `,
    [provider, providerSubject, providerOrganization || null],
  );

  return result.rows[0] || null;
}

export async function findOrCreateChatSession({
  userId,
  provider,
  providerSession,
  providerSubject,
}) {
  const id = crypto.randomUUID();
  const result = await query(
    `
      INSERT INTO chat_sessions (
        id,
        user_id,
        provider,
        provider_session,
        provider_subject
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, provider_session, provider_subject)
        DO UPDATE SET last_seen_at = now()
      RETURNING *
    `,
    [id, userId, provider, providerSession, providerSubject],
  );

  return result.rows[0];
}

export async function reserveOutboundMessage({
  userId,
  chatSessionId,
  clientRequestId,
  deliveryProvider,
  fromEmail,
  fromName,
  toEmail,
  subject,
  textBody,
  abusePolicy,
  enforceAbuseControls = true,
}) {
  return transaction(async (txQuery) => {
    const policyLockKeys = ['global', `user:${userId}`].sort();
    await txQuery(
      `
        INSERT INTO outbound_policy_locks (lock_key)
        SELECT unnest($1::text[])
        ON CONFLICT (lock_key) DO NOTHING
      `,
      [policyLockKeys],
    );
    await txQuery(
      `
        SELECT lock_key
        FROM outbound_policy_locks
        WHERE lock_key = ANY($1::text[])
        ORDER BY lock_key
        FOR UPDATE
      `,
      [policyLockKeys],
    );

    const existing = await txQuery(
      `
        SELECT *
        FROM messages
        WHERE user_id = $1
          AND direction = 'outbound'
          AND client_request_id = $2
      `,
      [userId, clientRequestId],
    );

    if (existing.rowCount > 0) {
      return { message: existing.rows[0], created: false };
    }

    const userResult = await txQuery(
      `SELECT ${USER_SELECT} FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error('Outbound user was not found.');
    }

    if (chatSessionId) {
      const session = await txQuery(
        'SELECT 1 FROM chat_sessions WHERE id = $1 AND user_id = $2',
        [chatSessionId, userId],
      );
      if (session.rowCount === 0) {
        const error = new Error('The chat session does not belong to the sending user.');
        error.code = 'invalid_chat_session';
        throw error;
      }
    }

    const clock = await txQuery('SELECT transaction_timestamp() AS now');
    const now = new Date(clock.rows[0].now);
    const tierPolicy = abusePolicy[user.account_tier];
    if (!tierPolicy) {
      throw new Error(`No outbound policy is configured for tier "${user.account_tier}".`);
    }

    let isNewRecipient = false;
    let decision = null;
    if (enforceAbuseControls) {
      const relationship = await txQuery(
        `
          SELECT first_inbound_at, first_outbound_at
          FROM recipient_relationships
          WHERE user_id = $1 AND recipient_email = $2
        `,
        [userId, toEmail],
      );
      isNewRecipient = relationship.rowCount === 0;
      decision = await evaluateOutboundPolicy(txQuery, {
        abusePolicy,
        tierPolicy,
        user,
        userId,
        chatSessionId,
        isNewRecipient,
        now,
      });
    }

    const id = crypto.randomUUID();
    const deliveryDetails = decision
      ? { abuse: { limitType: decision.limitType, retryAfter: decision.retryAfter } }
      : {};
    const deliveryStatus = decision ? 'rejected' : 'submitting';
    const inserted = await txQuery(
      `
        INSERT INTO messages (
          id,
          user_id,
          chat_session_id,
          direction,
          from_email,
          from_name,
          to_email,
          subject,
          text_body,
          processing_status,
          client_request_id,
          delivery_provider,
          delivery_status,
          delivery_details,
          delivery_error_code,
          delivery_error_message,
          last_send_attempt_at
        )
        VALUES (
          $1, $2, $3, 'outbound', $4, $5, $6, $7, $8, NULL, $9, $10,
          $11, $12, $13, $14, $15
        )
        RETURNING *
      `,
      [
        id,
        userId,
        chatSessionId || null,
        fromEmail,
        fromName,
        toEmail,
        subject || '',
        textBody || '',
        clientRequestId,
        deliveryProvider,
        deliveryStatus,
        JSON.stringify(deliveryDetails),
        decision?.code || null,
        decision?.message || null,
        decision ? null : now,
      ],
    );

    if (decision) {
      return { message: inserted.rows[0], created: true, rejected: true };
    }

    if (!enforceAbuseControls) {
      return { message: inserted.rows[0], created: true, rejected: false };
    }

    const hourStart = startOfUtcHour(now);
    const dayStart = startOfUtcDay(now);
    await incrementUsage(txQuery, 'global', 'all', 'hour', hourStart);
    await incrementUsage(txQuery, 'global', 'all', 'day', dayStart);
    await incrementUsage(txQuery, 'user', userId, 'hour', hourStart);
    await incrementUsage(txQuery, 'user', userId, 'day', dayStart);
    if (chatSessionId) {
      await incrementUsage(txQuery, 'session', chatSessionId, 'hour', hourStart);
    }
    if (isNewRecipient) {
      await incrementUsage(
        txQuery,
        'user_new_recipient',
        userId,
        'day',
        dayStart,
      );
    }

    await txQuery(
      `
        INSERT INTO recipient_relationships (
          user_id,
          recipient_email,
          first_outbound_at,
          last_outbound_at
        )
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (user_id, recipient_email)
        DO UPDATE SET
          first_outbound_at = COALESCE(
            recipient_relationships.first_outbound_at,
            EXCLUDED.first_outbound_at
          ),
          last_outbound_at = EXCLUDED.last_outbound_at
      `,
      [userId, toEmail, now],
    );

    return { message: inserted.rows[0], created: true, rejected: false };
  });
}

export async function completeOutboundMessage({
  userId,
  messageId,
  providerMessageId,
  deliveryStatus,
  deliveryDetails,
  sentAt,
}) {
  const result = await query(
    `
      UPDATE messages
      SET provider_message_id = $3,
          delivery_status = $4,
          delivery_details = $5,
          delivery_error_code = NULL,
          delivery_error_message = NULL,
          sent_at = $6
      WHERE id = $1
        AND user_id = $2
        AND direction = 'outbound'
        AND delivery_status = 'submitting'
      RETURNING *
    `,
    [
      messageId,
      userId,
      providerMessageId || null,
      deliveryStatus,
      JSON.stringify(deliveryDetails || {}),
      sentAt,
    ],
  );

  return result.rows[0] || null;
}

export async function failOutboundMessage({
  userId,
  messageId,
  deliveryStatus,
  errorCode,
  errorMessage,
}) {
  const result = await query(
    `
      UPDATE messages
      SET delivery_status = $3,
          delivery_error_code = $4,
          delivery_error_message = $5
      WHERE id = $1
        AND user_id = $2
        AND direction = 'outbound'
        AND delivery_status = 'submitting'
      RETURNING *
    `,
    [messageId, userId, deliveryStatus, errorCode || null, errorMessage],
  );

  return result.rows[0] || null;
}

export async function createInboundMessage({
  userId,
  chatSessionId,
  fromEmail,
  toEmail,
  subject,
  textBody,
  providerMessageId,
  receivedAt,
}) {
  const id = crypto.randomUUID();
  const result = await query(
    `
      INSERT INTO messages (
        id,
        user_id,
        chat_session_id,
        direction,
        from_email,
        to_email,
        subject,
        text_body,
        provider_message_id,
        processing_status,
        received_at
      )
      VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, 'pending', $9)
      ON CONFLICT (user_id, provider_message_id)
        WHERE direction = 'inbound' AND provider_message_id IS NOT NULL
        DO NOTHING
      RETURNING *
    `,
    [
      id,
      userId,
      chatSessionId || null,
      fromEmail,
      toEmail,
      subject || '',
      textBody || '',
      providerMessageId || null,
      receivedAt || null,
    ],
  );

  if (result.rowCount > 0) {
    return { message: result.rows[0], created: true };
  }

  const existing = await query(
    `
      SELECT *
      FROM messages
      WHERE user_id = $1
        AND direction = 'inbound'
        AND provider_message_id = $2
    `,
    [userId, providerMessageId],
  );

  if (existing.rowCount === 0) {
    throw new Error('Inbound message conflict did not resolve to an existing row.');
  }

  return { message: existing.rows[0], created: false };
}

export async function recordInboundRelationship({ userId, senderEmail, receivedAt }) {
  const timestamp = receivedAt || new Date();
  await query(
    `
      INSERT INTO recipient_relationships (
        user_id,
        recipient_email,
        first_inbound_at,
        last_inbound_at
      )
      VALUES ($1, $2, $3, $3)
      ON CONFLICT (user_id, recipient_email)
      DO UPDATE SET
        first_inbound_at = COALESCE(
          recipient_relationships.first_inbound_at,
          EXCLUDED.first_inbound_at
        ),
        last_inbound_at = GREATEST(
          recipient_relationships.last_inbound_at,
          EXCLUDED.last_inbound_at
        )
    `,
    [userId, senderEmail.toLowerCase(), timestamp],
  );
}

export async function updateUserAccountTier(userId, accountTier) {
  const result = await query(
    `
      UPDATE users
      SET account_tier = $2
      WHERE id = $1
      RETURNING ${USER_SELECT}
    `,
    [userId, accountTier],
  );
  return result.rows[0] || null;
}

export async function suspendUserSending(userId, reason) {
  const result = await query(
    `
      UPDATE users
      SET sending_status = 'suspended',
          sending_suspended_at = now(),
          sending_suspension_reason = $2
      WHERE id = $1
      RETURNING ${USER_SELECT}
    `,
    [userId, reason],
  );
  return result.rows[0] || null;
}

export async function reactivateUserSending(userId) {
  const result = await query(
    `
      UPDATE users
      SET sending_status = 'active',
          sending_suspended_at = NULL,
          sending_suspension_reason = NULL
      WHERE id = $1
      RETURNING ${USER_SELECT}
    `,
    [userId],
  );
  return result.rows[0] || null;
}

export async function getOutboundUsageSnapshot(userId, chatSessionId) {
  const result = await query(
    `
      WITH clock AS (
        SELECT
          date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour_start,
          date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
      )
      SELECT scope_type, scope_key, bucket_type, bucket_start, used_count
      FROM outbound_usage_buckets, clock
      WHERE (
        (scope_type = 'global' AND scope_key = 'all')
        OR (scope_type IN ('user', 'user_new_recipient') AND scope_key = $1)
        OR (scope_type = 'session' AND scope_key = $2)
      )
        AND (
          (bucket_type = 'hour' AND bucket_start = clock.hour_start)
          OR (bucket_type = 'day' AND bucket_start = clock.day_start)
        )
      ORDER BY scope_type, bucket_type
    `,
    [userId, chatSessionId || ''],
  );
  return result.rows;
}

export async function getLatestOutboundAttempt(userId) {
  const result = await query(
    `
      SELECT max(last_send_attempt_at) AS attempted_at
      FROM messages
      WHERE user_id = $1
        AND direction = 'outbound'
        AND last_send_attempt_at IS NOT NULL
    `,
    [userId],
  );
  return result.rows[0]?.attempted_at || null;
}

export async function listOutboundMessages({
  userId,
  limit,
  beforeCreatedAt,
  beforeId,
}) {
  const result = await query(
    `
      SELECT *
      FROM messages
      WHERE user_id = $1
        AND direction = 'outbound'
        AND (
          $2::timestamptz IS NULL
          OR (created_at, id) < ($2::timestamptz, $3::uuid)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $4
    `,
    [userId, beforeCreatedAt || null, beforeId || null, limit],
  );
  return result.rows;
}

export async function getOutboundMessageForUser({
  userId,
  messageId,
  requestId,
}) {
  const result = await query(
    `
      SELECT *
      FROM messages
      WHERE user_id = $1
        AND direction = 'outbound'
        AND (
          ($2::uuid IS NOT NULL AND id = $2::uuid)
          OR ($3::uuid IS NOT NULL AND client_request_id = $3::uuid)
        )
      LIMIT 1
    `,
    [userId, messageId || null, requestId || null],
  );
  return result.rows[0] || null;
}

export async function listInboundMessages({
  userId,
  processingStatus,
  limit,
  afterCreatedAt,
  afterId,
}) {
  const result = await query(
    `
      SELECT *
      FROM messages
      WHERE user_id = $1
        AND direction = 'inbound'
        AND processing_status = $2
        AND (
          $3::timestamptz IS NULL
          OR (created_at, id) > ($3::timestamptz, $4::uuid)
        )
      ORDER BY created_at ASC, id ASC
      LIMIT $5
    `,
    [
      userId,
      processingStatus,
      afterCreatedAt || null,
      afterId || null,
      limit,
    ],
  );

  return result.rows;
}

export async function acknowledgeInboundMessages(userId, messageIds) {
  const updated = await query(
    `
      UPDATE messages
      SET processing_status = 'processed',
          processed_at = COALESCE(processed_at, now())
      WHERE user_id = $1
        AND direction = 'inbound'
        AND id = ANY($2::uuid[])
        AND processing_status IN ('pending', 'leased')
      RETURNING id
    `,
    [userId, messageIds],
  );

  const existing = await query(
    `
      SELECT id, processing_status, processed_at
      FROM messages
      WHERE user_id = $1
        AND direction = 'inbound'
        AND id = ANY($2::uuid[])
    `,
    [userId, messageIds],
  );

  return {
    updatedIds: updated.rows.map((row) => row.id),
    existing: existing.rows,
  };
}

export async function getMessageForUser(userId, messageId) {
  const result = await query(
    'SELECT * FROM messages WHERE user_id = $1 AND id = $2',
    [userId, messageId],
  );

  return result.rows[0] || null;
}

async function evaluateOutboundPolicy(txQuery, {
  abusePolicy,
  tierPolicy,
  user,
  userId,
  chatSessionId,
  isNewRecipient,
  now,
}) {
  if (!abusePolicy.enabled) {
    return rejection(
      'sending_disabled',
      'global_kill_switch',
      'Outbound sending is disabled by the service operator.',
    );
  }

  if (user.sending_status === 'suspended') {
    return rejection(
      'sending_suspended',
      'user_suspended',
      user.sending_suspension_reason || 'Outbound sending is suspended for this user.',
    );
  }

  const hourStart = startOfUtcHour(now);
  const dayStart = startOfUtcDay(now);
  const checks = [
    ['global', 'all', 'hour', hourStart, abusePolicy.global.hourlyLimit, 'global_hourly'],
    ['global', 'all', 'day', dayStart, abusePolicy.global.dailyLimit, 'global_daily'],
    ['user', userId, 'hour', hourStart, tierPolicy.hourlyLimit, 'user_hourly'],
    ['user', userId, 'day', dayStart, tierPolicy.dailyLimit, 'user_daily'],
  ];

  if (chatSessionId) {
    checks.push([
      'session',
      chatSessionId,
      'hour',
      hourStart,
      tierPolicy.sessionHourlyLimit,
      'session_hourly',
    ]);
  }
  if (isNewRecipient) {
    checks.push([
      'user_new_recipient',
      userId,
      'day',
      dayStart,
      tierPolicy.newRecipientDailyLimit,
      'new_recipients_daily',
    ]);
  }

  for (const [scopeType, scopeKey, bucketType, bucketStart, limit, limitType] of checks) {
    const used = await readUsage(
      txQuery,
      scopeType,
      scopeKey,
      bucketType,
      bucketStart,
    );
    if (used >= limit) {
      return rejection(
        'rate_limited',
        limitType,
        `The ${limitType.replaceAll('_', ' ')} limit has been reached.`,
        endOfBucket(bucketStart, bucketType),
      );
    }
  }

  const lastAttempt = await txQuery(
    `
      SELECT max(last_send_attempt_at) AS attempted_at
      FROM messages
      WHERE user_id = $1
        AND direction = 'outbound'
        AND last_send_attempt_at IS NOT NULL
    `,
    [userId],
  );
  if (lastAttempt.rows[0].attempted_at) {
    const retryAt = new Date(
      new Date(lastAttempt.rows[0].attempted_at).getTime()
        + tierPolicy.minimumIntervalSeconds * 1000,
    );
    if (retryAt > now) {
      return rejection(
        'rate_limited',
        'minimum_interval',
        'Send requests are arriving too quickly.',
        retryAt,
      );
    }
  }

  return null;
}

async function readUsage(txQuery, scopeType, scopeKey, bucketType, bucketStart) {
  const result = await txQuery(
    `
      SELECT used_count
      FROM outbound_usage_buckets
      WHERE scope_type = $1
        AND scope_key = $2
        AND bucket_type = $3
        AND bucket_start = $4
    `,
    [scopeType, scopeKey, bucketType, bucketStart],
  );
  return result.rows[0]?.used_count || 0;
}

async function incrementUsage(
  txQuery,
  scopeType,
  scopeKey,
  bucketType,
  bucketStart,
) {
  await txQuery(
    `
      INSERT INTO outbound_usage_buckets (
        scope_type,
        scope_key,
        bucket_type,
        bucket_start,
        used_count
      )
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (scope_type, scope_key, bucket_type, bucket_start)
      DO UPDATE SET
        used_count = outbound_usage_buckets.used_count + 1,
        updated_at = now()
    `,
    [scopeType, scopeKey, bucketType, bucketStart],
  );
}

function rejection(code, limitType, message, retryAfter) {
  return {
    code,
    limitType,
    message,
    retryAfter: retryAfter ? retryAfter.toISOString() : null,
  };
}

function startOfUtcHour(date) {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function endOfBucket(bucketStart, bucketType) {
  const milliseconds = bucketType === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(bucketStart.getTime() + milliseconds);
}
