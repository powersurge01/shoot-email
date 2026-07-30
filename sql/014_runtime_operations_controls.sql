CREATE TABLE IF NOT EXISTS service_runtime_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  outbound_sending_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  outbound_disabled_reason TEXT,
  updated_by TEXT NOT NULL DEFAULT 'migration',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    outbound_sending_enabled
    OR (
      outbound_disabled_reason IS NOT NULL
      AND length(trim(outbound_disabled_reason)) BETWEEN 1 AND 500
    )
  )
);

INSERT INTO service_runtime_controls (
  singleton,
  outbound_sending_enabled,
  outbound_disabled_reason,
  updated_by
)
VALUES (TRUE, TRUE, NULL, 'migration')
ON CONFLICT (singleton) DO NOTHING;
