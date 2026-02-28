CREATE TABLE IF NOT EXISTS artists (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  ig_handle    TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_posts (
  id          SERIAL PRIMARY KEY,
  artist_id   TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  post_url    TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INT NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_oembed_cache (
  post_url          TEXT PRIMARY KEY,
  provider          TEXT,
  author_name       TEXT,
  author_url        TEXT,
  title             TEXT,
  thumbnail_url     TEXT,
  thumbnail_width   INT,
  thumbnail_height  INT,
  html              TEXT,
  cached_thumb_path TEXT,
  fetched_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_oembed_expires_at    ON ig_oembed_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_oembed_status        ON ig_oembed_cache(status);
CREATE INDEX IF NOT EXISTS idx_posts_artist_active  ON ig_posts(artist_id, is_active, is_pinned, sort_order);
CREATE INDEX IF NOT EXISTS idx_artists_active_order ON artists(is_active, sort_order);
