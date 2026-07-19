DELETE FROM outbound_usage_buckets;
DELETE FROM recipient_relationships;

WITH relationship_events AS (
  SELECT
    user_id,
    lower(from_email) AS recipient_email,
    COALESCE(received_at, created_at) AS inbound_at,
    NULL::timestamptz AS outbound_at
  FROM messages
  WHERE direction = 'inbound'
  UNION ALL
  SELECT
    user_id,
    lower(to_email),
    NULL,
    last_send_attempt_at
  FROM messages
  WHERE direction = 'outbound'
    AND delivery_provider <> 'mock'
    AND delivery_status <> 'rejected'
    AND last_send_attempt_at IS NOT NULL
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
  user_id,
  recipient_email,
  min(inbound_at) FILTER (WHERE inbound_at IS NOT NULL),
  max(inbound_at) FILTER (WHERE inbound_at IS NOT NULL),
  min(outbound_at) FILTER (WHERE outbound_at IS NOT NULL),
  max(outbound_at) FILTER (WHERE outbound_at IS NOT NULL)
FROM relationship_events
GROUP BY user_id, recipient_email;

WITH clock AS (
  SELECT
    date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour_start,
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
),
attempts AS (
  SELECT messages.*
  FROM messages, clock
  WHERE direction = 'outbound'
    AND delivery_provider <> 'mock'
    AND delivery_status <> 'rejected'
    AND last_send_attempt_at >= clock.day_start
),
expanded AS (
  SELECT
    scopes.scope_type,
    scopes.scope_key,
    scopes.bucket_type,
    scopes.bucket_start
  FROM attempts
  CROSS JOIN clock
  CROSS JOIN LATERAL (
    VALUES
      ('global'::text, 'all'::text, 'day'::text, clock.day_start),
      ('user', attempts.user_id::text, 'day', clock.day_start),
      ('global', 'all', 'hour', clock.hour_start),
      ('user', attempts.user_id::text, 'hour', clock.hour_start),
      ('session', attempts.chat_session_id::text, 'hour', clock.hour_start)
  ) AS scopes(scope_type, scope_key, bucket_type, bucket_start)
  WHERE scopes.scope_key IS NOT NULL
    AND (
      scopes.bucket_type = 'day'
      OR attempts.last_send_attempt_at >= clock.hour_start
    )
)
INSERT INTO outbound_usage_buckets (
  scope_type,
  scope_key,
  bucket_type,
  bucket_start,
  used_count
)
SELECT scope_type, scope_key, bucket_type, bucket_start, count(*)::integer
FROM expanded
GROUP BY scope_type, scope_key, bucket_type, bucket_start;

WITH clock AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start
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
  clock.day_start,
  count(*)::integer
FROM recipient_relationships
CROSS JOIN clock
WHERE first_outbound_at >= clock.day_start
  AND (
    first_inbound_at IS NULL
    OR first_inbound_at >= first_outbound_at
  )
GROUP BY user_id, clock.day_start;
