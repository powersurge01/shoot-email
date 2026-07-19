WITH inbound AS (
  SELECT
    user_id,
    lower(from_email) AS recipient_email,
    min(COALESCE(received_at, created_at)) AS first_inbound_at,
    max(COALESCE(received_at, created_at)) AS last_inbound_at
  FROM messages
  WHERE direction = 'inbound'
  GROUP BY user_id, lower(from_email)
),
outbound AS (
  SELECT
    user_id,
    lower(to_email) AS recipient_email,
    min(last_send_attempt_at) AS first_outbound_at,
    max(last_send_attempt_at) AS last_outbound_at
  FROM messages
  WHERE direction = 'outbound'
    AND delivery_status <> 'rejected'
    AND last_send_attempt_at IS NOT NULL
  GROUP BY user_id, lower(to_email)
),
correspondents AS (
  SELECT user_id, recipient_email FROM inbound
  UNION
  SELECT user_id, recipient_email FROM outbound
)
INSERT INTO recipient_relationships (
  user_id,
  recipient_email,
  first_inbound_at,
  last_inbound_at,
  first_outbound_at,
  last_outbound_at
)
SELECT
  correspondents.user_id,
  correspondents.recipient_email,
  inbound.first_inbound_at,
  inbound.last_inbound_at,
  outbound.first_outbound_at,
  outbound.last_outbound_at
FROM correspondents
LEFT JOIN inbound USING (user_id, recipient_email)
LEFT JOIN outbound USING (user_id, recipient_email)
ON CONFLICT (user_id, recipient_email)
DO UPDATE SET
  first_inbound_at = CASE
    WHEN recipient_relationships.first_inbound_at IS NULL THEN EXCLUDED.first_inbound_at
    WHEN EXCLUDED.first_inbound_at IS NULL THEN recipient_relationships.first_inbound_at
    ELSE LEAST(recipient_relationships.first_inbound_at, EXCLUDED.first_inbound_at)
  END,
  last_inbound_at = CASE
    WHEN recipient_relationships.last_inbound_at IS NULL THEN EXCLUDED.last_inbound_at
    WHEN EXCLUDED.last_inbound_at IS NULL THEN recipient_relationships.last_inbound_at
    ELSE GREATEST(recipient_relationships.last_inbound_at, EXCLUDED.last_inbound_at)
  END,
  first_outbound_at = CASE
    WHEN recipient_relationships.first_outbound_at IS NULL THEN EXCLUDED.first_outbound_at
    WHEN EXCLUDED.first_outbound_at IS NULL THEN recipient_relationships.first_outbound_at
    ELSE LEAST(recipient_relationships.first_outbound_at, EXCLUDED.first_outbound_at)
  END,
  last_outbound_at = CASE
    WHEN recipient_relationships.last_outbound_at IS NULL THEN EXCLUDED.last_outbound_at
    WHEN EXCLUDED.last_outbound_at IS NULL THEN recipient_relationships.last_outbound_at
    ELSE GREATEST(recipient_relationships.last_outbound_at, EXCLUDED.last_outbound_at)
  END;

WITH clock AS (
  SELECT
    date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour_start,
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
),
attempts AS (
  SELECT messages.*
  FROM messages, clock
  WHERE direction = 'outbound'
    AND delivery_status <> 'rejected'
    AND last_send_attempt_at >= clock.day_start
),
buckets AS (
  SELECT 'global'::text AS scope_type, 'all'::text AS scope_key,
    'hour'::text AS bucket_type, clock.hour_start AS bucket_start,
    count(*)::integer AS used_count
  FROM attempts, clock
  WHERE attempts.last_send_attempt_at >= clock.hour_start
  GROUP BY clock.hour_start
  UNION ALL
  SELECT 'global', 'all', 'day', clock.day_start, count(*)::integer
  FROM attempts, clock
  GROUP BY clock.day_start
  UNION ALL
  SELECT 'user', attempts.user_id::text, 'hour', clock.hour_start, count(*)::integer
  FROM attempts, clock
  WHERE attempts.last_send_attempt_at >= clock.hour_start
  GROUP BY attempts.user_id, clock.hour_start
  UNION ALL
  SELECT 'user', attempts.user_id::text, 'day', clock.day_start, count(*)::integer
  FROM attempts, clock
  GROUP BY attempts.user_id, clock.day_start
  UNION ALL
  SELECT 'session', attempts.chat_session_id::text, 'hour', clock.hour_start,
    count(*)::integer
  FROM attempts, clock
  WHERE attempts.last_send_attempt_at >= clock.hour_start
    AND attempts.chat_session_id IS NOT NULL
  GROUP BY attempts.chat_session_id, clock.hour_start
)
INSERT INTO outbound_usage_buckets (
  scope_type,
  scope_key,
  bucket_type,
  bucket_start,
  used_count
)
SELECT scope_type, scope_key, bucket_type, bucket_start, used_count
FROM buckets
WHERE used_count > 0
ON CONFLICT (scope_type, scope_key, bucket_type, bucket_start)
DO UPDATE SET used_count = GREATEST(
  outbound_usage_buckets.used_count,
  EXCLUDED.used_count
);

WITH clock AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
),
new_recipients AS (
  SELECT
    recipient_relationships.user_id,
    count(*)::integer AS used_count,
    clock.day_start
  FROM recipient_relationships, clock
  WHERE first_outbound_at >= clock.day_start
    AND (
      first_inbound_at IS NULL
      OR first_inbound_at >= first_outbound_at
    )
  GROUP BY recipient_relationships.user_id, clock.day_start
)
INSERT INTO outbound_usage_buckets (
  scope_type,
  scope_key,
  bucket_type,
  bucket_start,
  used_count
)
SELECT
  'user_new_recipient',
  user_id::text,
  'day',
  day_start,
  used_count
FROM new_recipients
ON CONFLICT (scope_type, scope_key, bucket_type, bucket_start)
DO UPDATE SET used_count = GREATEST(
  outbound_usage_buckets.used_count,
  EXCLUDED.used_count
);
