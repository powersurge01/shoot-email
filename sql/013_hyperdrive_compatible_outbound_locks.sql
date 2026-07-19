CREATE TABLE IF NOT EXISTS outbound_policy_locks (
  lock_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO outbound_policy_locks (lock_key)
VALUES ('global')
ON CONFLICT (lock_key) DO NOTHING;
