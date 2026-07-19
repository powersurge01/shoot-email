CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email_alias TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_organization TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_subject_org_key
    UNIQUE NULLS NOT DISTINCT (provider, provider_subject, provider_organization)
);

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

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  processing_status TEXT,
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT messages_processing_status_check CHECK (
    (direction = 'inbound' AND processing_status IN ('pending', 'leased', 'processed'))
    OR (direction = 'outbound' AND processing_status IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS messages_user_created_idx
  ON messages(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_user_direction_created_idx
  ON messages(user_id, direction, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_user_pending_created_idx
  ON messages(user_id, created_at, id)
  WHERE direction = 'inbound' AND processing_status = 'pending';

CREATE INDEX IF NOT EXISTS messages_chat_session_created_idx
  ON messages(chat_session_id, created_at DESC)
  WHERE chat_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, embedding_model)
);
