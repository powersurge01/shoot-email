CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_organization TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_identities_provider_subject_org_key'
  ) THEN
    ALTER TABLE user_identities
      ADD CONSTRAINT user_identities_provider_subject_org_key
      UNIQUE NULLS NOT DISTINCT (provider, provider_subject, provider_organization);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_identities_user_idx
  ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_session TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_session, provider_subject)
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_last_seen_idx
  ON chat_sessions(user_id, last_seen_at DESC);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS chat_session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_chat_session_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_chat_session_id_fkey
      FOREIGN KEY (chat_session_id)
      REFERENCES chat_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_chat_session_created_idx
  ON messages(chat_session_id, created_at DESC)
  WHERE chat_session_id IS NOT NULL;
