ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID,
  ADD COLUMN IF NOT EXISTS delivery_provider TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS delivery_error_code TEXT,
  ADD COLUMN IF NOT EXISTS delivery_error_message TEXT,
  ADD COLUMN IF NOT EXISTS last_send_attempt_at TIMESTAMPTZ;

UPDATE messages
SET client_request_id = id,
    delivery_provider = CASE
      WHEN provider_message_id LIKE 'mock-%' THEN 'mock'
      ELSE 'legacy'
    END,
    delivery_status = 'delivered',
    last_send_attempt_at = COALESCE(sent_at, created_at)
WHERE direction = 'outbound'
  AND client_request_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_outbound_delivery_check'
  ) THEN
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
            'unknown'
          )
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS messages_user_outbound_request_key
  ON messages(user_id, client_request_id)
  WHERE direction = 'outbound';
