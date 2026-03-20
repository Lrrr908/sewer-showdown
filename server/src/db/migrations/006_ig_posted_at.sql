ALTER TABLE ig_posts ADD COLUMN IF NOT EXISTS ig_posted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ig_posts_posted_at ON ig_posts(ig_posted_at DESC);
