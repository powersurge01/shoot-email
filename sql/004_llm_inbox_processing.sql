ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS processing_status TEXT,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

UPDATE messages
SET processing_status = CASE
  WHEN direction = 'inbound' THEN 'pending'
  ELSE NULL
END
WHERE processing_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_processing_status_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_processing_status_check CHECK (
        (direction = 'inbound' AND processing_status IN ('pending', 'leased', 'processed'))
        OR (direction = 'outbound' AND processing_status IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_user_pending_created_idx
  ON messages(user_id, created_at, id)
  WHERE direction = 'inbound' AND processing_status = 'pending';

CREATE INDEX IF NOT EXISTS messages_user_processed_created_idx
  ON messages(user_id, created_at, id)
  WHERE direction = 'inbound' AND processing_status = 'processed';
