#!/usr/bin/env node
// ============================================================
// fix_ig_thumbs.js
// Visits each ig_post that has no manual_thumb_url, grabs
// the full-res image via Playwright, downloads it locally,
// and updates the feed JSON.
//
// Usage:  node server/src/db/fix_ig_thumbs.js
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const { chromium } = require('playwright');
const { Pool } = require('pg');

const ROOT       = path.resolve(__dirname, '../../../');
const THUMBS_DIR = path.join(ROOT, 'data/ig-thumbs');
const IG_DIR     = path.join(ROOT, 'data/ig');
fs.mkdirSync(THUMBS_DIR, { recursive: true });

function shortcode(postUrl) {
    const m = postUrl.match(/\/p\/([^/]+)/);
    return m ? m[1] : null;
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' },
            timeout: 20000,
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const ws = fs.createWriteStream(dest);
            res.pipe(ws);
            ws.on('finish', resolve); ws.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const SESSION_DIR = path.join(process.env.HOME || '/tmp', '.sewer-ig-session');
const PAGE_TIMEOUT = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Recursively search a JSON object for the highest-res Instagram image URL
function findBestImageUrl(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    let best = { url: null, width: 0 };

    // image_versions2.candidates array — has multiple resolutions
    if (Array.isArray(obj.candidates)) {
        for (const c of obj.candidates) {
            if (c.url && c.url.includes('cdninstagram.com') && (c.width || 0) > best.width) {
                best = { url: c.url, width: c.width || 0 };
            }
        }
        if (best.url) return best;
    }
    // display_url is full-res on some response shapes
    if (typeof obj.display_url === 'string' && obj.display_url.includes('cdninstagram.com')) {
        best = { url: obj.display_url, width: 9999 };
    }
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
            const found = findBestImageUrl(obj[key], depth + 1);
            if (found && found.width > best.width) best = found;
        }
    }
    return best.url ? best : null;
}

async function getThumb(page, postUrl) {
    // Navigate and wait just until the main content loads (not networkidle — that waits for
    // suggested-post background calls which pollute the response listener with other images)
    try {
        await page.goto(postUrl, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
    } catch {}

    // Wait for the main post image — Instagram renders it inside div._aagv
    try {
        await page.waitForSelector('div._aagv img', { timeout: 12000 });
    } catch {}

    await sleep(1500);

    // Pull from div._aagv only — this is always THIS post's image, never suggested content
    const result = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('div._aagv img'));
        let bestUrl = null, bestW = 0;
        for (const img of imgs) {
            if (img.currentSrc && img.currentSrc.includes('cdninstagram')) {
                const w = img.naturalWidth || 0;
                if (w > bestW) { bestW = w; bestUrl = img.currentSrc; }
            }
            const srcset = img.getAttribute('srcset') || '';
            for (const part of srcset.split(',')) {
                const [url, wStr] = part.trim().split(/\s+/);
                const w = parseInt(wStr) || 0;
                if (url && url.includes('cdninstagram') && w > bestW) {
                    bestW = w; bestUrl = url;
                }
            }
        }
        return bestUrl ? { url: bestUrl, width: bestW } : null;
    });

    if (result) {
        process.stdout.write(`[dom:${result.width}] `);
        return result.url;
    }

    // Fallback: og:image
    try {
        const og = await page.locator('meta[property="og:image"]').getAttribute('content', { timeout: 4000 });
        if (og && og.startsWith('http')) {
            process.stdout.write('[og:fallback] ');
            return og;
        }
    } catch {}

    return null;
}

(async () => {
    // Build work queue from JSON files — any item whose imageUrl is a CDN URL
    // or points to a local file that doesn't exist yet
    const posts = [];
    const jsonFiles = fs.readdirSync(IG_DIR).filter(f => f.endsWith('.json'));
    for (const file of jsonFiles) {
        const artistId = file.replace('.json', '');
        let feed;
        try { feed = JSON.parse(fs.readFileSync(path.join(IG_DIR, file), 'utf8')); } catch { continue; }
        for (const item of (feed.items || [])) {
            const url = item.imageUrl || '';
            const sc = shortcode(item.postUrl);
            if (!sc) continue;
            const localFile = path.join(THUMBS_DIR, sc + '.jpg');
            const needsDownload = url.startsWith('https://') || !fs.existsSync(localFile);
            if (needsDownload) {
                posts.push({ artist_id: artistId, post_url: item.postUrl, postedAt: item.postedAt || null });
            }
        }
    }
    // Tonight's posts first
    posts.sort((a, b) => (b.postedAt ? 1 : 0) - (a.postedAt ? 1 : 0));

    if (posts.length === 0) {
        console.log('All images already downloaded.');
        await pool.end();
        return;
    }

    console.log(`Found ${posts.length} images to download. Opening browser…`);

    const browser = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        viewport: { width: 1440, height: 1800 },
        deviceScaleFactor: 3,   // retina — forces Instagram to serve the highest-res srcset entry
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);

    let ok = 0, fail = 0;
    for (const post of posts) {
        process.stdout.write(`[${post.artist_id}] … `);
        const cdnUrl = await getThumb(page, post.post_url);
        if (!cdnUrl) { console.log('✗ no image found'); fail++; await sleep(1200); continue; }

        // Download to local file
        const sc = shortcode(post.post_url);
        const localFile = sc ? path.join(THUMBS_DIR, sc + '.jpg') : null;
        let localPath = null;
        if (localFile) {
            try {
                await downloadFile(cdnUrl, localFile);
                const kb = Math.round(fs.statSync(localFile).size / 1024);
                localPath = 'data/ig-thumbs/' + sc + '.jpg';
                process.stdout.write(kb + 'KB ');
            } catch (e) {
                process.stdout.write('(download failed: ' + e.message + ') ');
            }
        }

        // Save CDN URL to DB (best-effort — old posts may not be in DB)
        try {
            await pool.query(
                `UPDATE ig_posts SET manual_thumb_url = $1, updated_at = now() WHERE post_url = $2`,
                [cdnUrl, post.post_url]
            );
        } catch {}

        // Update feed JSON to use local path
        const jsonFile = path.join(IG_DIR, post.artist_id + '.json');
        if (fs.existsSync(jsonFile)) {
            const feed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
            for (const item of feed.items) {
                if (item.postUrl === post.post_url) {
                    item.imageUrl = localPath || cdnUrl;
                    item.status = localPath ? 'local' : 'cdn';
                }
            }
            fs.writeFileSync(jsonFile, JSON.stringify(feed));
        }

        console.log('✓');
        ok++;
        await sleep(3000 + Math.random() * 2000);
    }

    console.log(`\nDone: ${ok} updated, ${fail} failed`);
    await browser.close();
    await pool.end();
})();
