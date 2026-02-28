const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const _rawCacheDir = process.env.THUMB_CACHE_DIR || '/tmp/ig_thumbs';
if (!path.isAbsolute(_rawCacheDir)) {
  throw new Error(
    `THUMB_CACHE_DIR must be an absolute path, got: "${_rawCacheDir}". ` +
    `Use /tmp/ig_thumbs or a mounted volume path.`
  );
}
const CACHE_DIR = _rawCacheDir;

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function cacheThumbnail(thumbnailUrl) {
  if (!thumbnailUrl) return null;

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const hash = crypto.createHash('sha1').update(thumbnailUrl).digest('hex');
  const filename = `${hash}.jpg`;
  const outPath = path.join(CACHE_DIR, filename);

  if (await fileExists(outPath)) return filename;

  let resp;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    resp = await fetch(thumbnailUrl, { signal: ac.signal });
    clearTimeout(t);
  } catch { return null; }
  if (!resp.ok) return null;

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 1024) return null;

  await fs.writeFile(outPath, buf);
  return filename;
}

module.exports = { cacheThumbnail, CACHE_DIR };
