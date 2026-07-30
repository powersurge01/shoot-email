ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS account_status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS account_status_reason TEXT,
  ADD COLUMN IF NOT EXISTS account_status_updated_by TEXT NOT NULL DEFAULT 'migration',
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_account_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_account_status_check CHECK (
        (
          account_status = 'active'
          AND account_status_reason IS NULL
          AND anonymized_at IS NULL
        )
        OR (
          account_status = 'disabled'
          AND account_status_reason IS NOT NULL
          AND anonymized_at IS NULL
        )
        OR (
          account_status = 'anonymized'
          AND account_status_reason IS NOT NULL
          AND anonymized_at IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS beta_access_grants (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_organization TEXT,
  access_status TEXT NOT NULL CHECK (access_status IN ('active', 'disabled')),
  outbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status_reason TEXT,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT beta_access_grants_identity_key
    UNIQUE NULLS NOT DISTINCT (
      provider,
      provider_subject,
      provider_organization
    ),
  CHECK (
    (access_status = 'active' AND status_reason IS NULL)
    OR (access_status = 'disabled' AND status_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS beta_access_grants_status_updated_idx
  ON beta_access_grants(access_status, updated_at DESC);

INSERT INTO beta_access_grants (
  provider,
  provider_subject,
  provider_organization,
  access_status,
  outbound_enabled,
  updated_by
)
SELECT
  provider,
  provider_subject,
  provider_organization,
  'active',
  TRUE,
  'migration'
FROM user_identities
WHERE provider LIKE 'auth0:%'
ON CONFLICT (
  provider,
  provider_subject,
  provider_organization
) DO NOTHING;
