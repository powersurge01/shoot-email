ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sender_display_name TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS from_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_sender_display_name_length_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_sender_display_name_length_check CHECK (
        sender_display_name IS NULL
        OR char_length(sender_display_name) BETWEEN 1 AND 80
      );
  END IF;
END $$;
