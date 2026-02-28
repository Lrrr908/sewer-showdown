const config = require('../config');

const OEMBED_TIMEOUT_MS = 8000;

async function fetchInstagramOEmbed(postUrl) {
  const params = new URLSearchParams({ url: postUrl });
  if (config.IG_OEMBED_TOKEN) params.set('access_token', config.IG_OEMBED_TOKEN);

  const endpoint = `https://graph.facebook.com/${config.META_GRAPH_VERSION}/instagram_oembed?${params}`;
  let resp, text;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), OEMBED_TIMEOUT_MS);
    resp = await fetch(endpoint, { signal: ac.signal });
    text = await resp.text();
    clearTimeout(t);
  } catch (e) {
    return { ok: false, error: `oembed_network_error: ${e.message}` };
  }

  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!resp.ok) {
    return { ok: false, error: data?.error?.message || `oembed_http_${resp.status}` };
  }

  return {
    ok: true,
    data: {
      provider:         'instagram',
      author_name:      data.author_name      ?? null,
      author_url:       data.author_url       ?? null,
      title:            data.title            ?? null,
      thumbnail_url:    data.thumbnail_url    ?? null,
      thumbnail_width:  data.thumbnail_width  ?? null,
      thumbnail_height: data.thumbnail_height ?? null,
      html:             data.html             ?? null,
    }
  };
}

module.exports = { fetchInstagramOEmbed };
