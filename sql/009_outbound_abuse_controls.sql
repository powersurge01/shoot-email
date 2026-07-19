ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_tier TEXT NOT NULL DEFAULT 'guest',
  ADD COLUMN IF NOT EXISTS sending_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS sending_suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sending_suspension_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_account_tier_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_account_tier_check
      CHECK (account_tier IN ('guest', 'registered'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_sending_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_sending_status_check
      CHECK (
        (sending_status = 'active'
          AND sending_suspended_at IS NULL
          AND sending_suspension_reason IS NULL)
        OR
        (sending_status = 'suspended'
          AND sending_suspended_at IS NOT NULL
          AND sending_suspension_reason IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_outbound_delivery_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_outbound_delivery_check CHECK (
    (
      direction = 'inbound'
      AND client_request_id IS NULL
      AND delivery_provider IS NULL
      AND delivery_status IS NULL
    )
    OR (
      direction = 'outbound'
      AND client_request_id IS NOT NULL
      AND delivery_provider IS NOT NULL
      AND delivery_status IN (
        'submitting',
        'queued',
        'delivered',
        'permanent_bounce',
        'failed',
        'unknown',
        'rejected'
      )
    )
  );

CREATE TABLE IF NOT EXISTS outbound_usage_buckets (
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('global', 'user', 'session', 'user_new_recipient')
  ),
  scope_key TEXT NOT NULL,
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('hour', 'day')),
  bucket_start TIMESTAMPTZ NOT NULL,
  used_count INTEGER NOT NULL CHECK (used_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_key, bucket_type, bucket_start)
);

CREATE INDEX IF NOT EXISTS outbound_usage_buckets_updated_idx
  ON outbound_usage_buckets(updated_at);

CREATE TABLE IF NOT EXISTS recipient_relationships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  first_inbound_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  first_outbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, recipient_email),
  CHECK (recipient_email = lower(recipient_email))
);

CREATE INDEX IF NOT EXISTS recipient_relationships_user_outbound_idx
  ON recipient_relationships(user_id, first_outbound_at)
  WHERE first_outbound_at IS NOT NULL;
