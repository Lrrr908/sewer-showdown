CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS ugc_sprites (
  ugc_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  base_sprite_key TEXT NOT NULL,

  width           INT NOT NULL,
  height          INT NOT NULL,

  rows            JSONB NOT NULL,
  mass            INT NOT NULL,
  base_mass       INT NOT NULL,

  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,

  hash            TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_ugc_sprites_account ON ugc_sprites(account_id);
CREATE INDEX IF NOT EXISTS idx_ugc_sprites_account_base ON ugc_sprites(account_id, base_sprite_key);
CREATE INDEX IF NOT EXISTS idx_ugc_sprites_created ON ugc_sprites(created_at DESC);
