ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_alias_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS user_email_aliases (
  email_alias TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('current', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CHECK (email_alias = lower(email_alias)),
  CHECK (
    (status = 'current' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_aliases_current_user_key
  ON user_email_aliases(user_id)
  WHERE status = 'current';

CREATE INDEX IF NOT EXISTS user_email_aliases_user_created_idx
  ON user_email_aliases(user_id, created_at DESC);

INSERT INTO user_email_aliases (email_alias, user_id, status)
SELECT lower(email_alias), id, 'current'
FROM users
ON CONFLICT (email_alias) DO NOTHING;
