#!/usr/bin/env node
// ============================================================
// fix_ig_thumbs.js
// Visits each ig_post that has no manual_thumb_url and
// fills it in from the OG image tag on the post page.
//
// Usage:  node server/src/db/fix_ig_thumbs.js
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path     = require('path');
const { chromium } = require('playwright');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const SESSION_DIR = path.join(process.env.HOME || '/tmp', '.sewer-ig-session');
const PAGE_TIMEOUT = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getThumb(page, postUrl) {
    try {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await sleep(2500);
    } catch (e) {
        console.log(`  nav failed: ${e.message}`);
        return null;
    }

    // Try OG image first
    try {
        const og = await page.locator('meta[property="og:image"]').getAttribute('content', { timeout: 6000 });
        if (og && og.startsWith('http')) return og;
    } catch {}

    // Fallback to article img
    for (const sel of ['article div[role="button"] img', 'article img[srcset]', 'article img[src]']) {
        try {
            const src = await page.locator(sel).first().getAttribute('src', { timeout: 3000 });
            if (src && src.startsWith('http')) return src;
        } catch {}
    }
    return null;
}

(async () => {
    const { rows: posts } = await pool.query(`
        SELECT id, artist_id, post_url
        FROM ig_posts
        WHERE manual_thumb_url IS NULL
        ORDER BY created_at DESC
    `);

    if (posts.length === 0) {
        console.log('All posts already have thumbnails.');
        await pool.end();
        return;
    }

    console.log(`Found ${posts.length} posts without thumbnails. Opening browser…`);

    const browser = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);

    let ok = 0, fail = 0;
    for (const post of posts) {
        process.stdout.write(`[${post.artist_id}] ${post.post_url.slice(0, 60)} … `);
        const thumb = await getThumb(page, post.post_url);
        if (thumb) {
            await pool.query(
                `UPDATE ig_posts SET manual_thumb_url = $1, updated_at = now() WHERE id = $2`,
                [thumb, post.id]
            );
            console.log('✓');
            ok++;
        } else {
            console.log('✗ no thumb found');
            fail++;
        }
        await sleep(3000 + Math.random() * 2000);
    }

    console.log(`\nDone: ${ok} updated, ${fail} failed`);
    await browser.close();
    await pool.end();
})();
