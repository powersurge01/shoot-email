DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'messages'
      AND column_name = 'postmark_message_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'messages'
      AND column_name = 'provider_message_id'
  ) THEN
    ALTER TABLE messages
      RENAME COLUMN postmark_message_id TO provider_message_id;
  END IF;
END $$;
