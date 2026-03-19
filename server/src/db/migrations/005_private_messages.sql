CREATE TABLE IF NOT EXISTS private_messages (
  msg_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     TEXT NOT NULL,
  from_dn     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  text        TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_pm_to_undelivered ON private_messages(to_id) WHERE delivered = FALSE;
