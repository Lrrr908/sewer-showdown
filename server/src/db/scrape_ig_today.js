#!/usr/bin/env node
// ============================================================
// scrape_ig_today.js
// Scrapes the most recent IG post for each active artist.
// Only saves posts published TODAY after 7 PM EST.
//
// Usage:
//   node server/src/db/scrape_ig_today.js
//
// First run: browser opens — log into Instagram.
// Session is saved to ~/.sewer-ig-session so you stay logged in
// on future runs (cookies + local storage persisted on disk).
// ============================================================

require('dotenv').config();
const path   = require('path');
const fs     = require('fs');
const { chromium } = require('playwright');

// DB is optional — results always written to scrape_results.json too
let pool;
try { pool = require('./pool'); } catch { pool = null; }

async function dbQuery(sql, params) {
    if (!pool) return null;
    try { return await pool.query(sql, params); } catch (e) {
        console.log(`  [db skip] ${e.message}`);
        return null;
    }
}

// ── Config ──────────────────────────────────────────────────
const SESSION_DIR    = path.join(process.env.HOME || '/tmp', '.sewer-ig-session');
const CUTOFF_HOUR_NY = 19;      // 7 PM America/New_York
const DELAY_BASE_MS  = 1500;    // min pause between artists
const DELAY_JITTER   = 1000;    // up to +1 s random extra
const PAGE_TIMEOUT   = 25000;
const PAUSE_AFTER_MS = 1200;    // settle time after navigation
// ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter()  { return DELAY_BASE_MS + Math.random() * DELAY_JITTER; }

// Returns { isToday, afterCutoff } in America/New_York time
function checkPostTime(isoStr) {
    const post = new Date(isoStr);
    const fmt = (opts) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts })
            .formatToParts(post)
            .reduce((o, p) => { o[p.type] = parseInt(p.value, 10); return o; }, {});

    const nowFmt = (opts) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts })
            .formatToParts(new Date())
            .reduce((o, p) => { o[p.type] = parseInt(p.value, 10); return o; }, {});

    const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    const n = nowFmt({ year: 'numeric', month: '2-digit', day: '2-digit' });

    const isToday    = p.year === n.year && p.month === n.month && p.day === n.day;
    const afterCutoff = p.hour >= CUTOFF_HOUR_NY;
    return { isToday, afterCutoff };
}

// Navigate to a URL and wait for it to settle
async function goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(PAUSE_AFTER_MS + Math.random() * 1000);
}

// Collect up to MAX_CANDIDATES post links from the profile grid.
// We gather several because the first slot(s) may be pinned (old) posts.
const MAX_CANDIDATES = 9;

async function getProfilePostUrls(page) {
    const strategies = [
        'article a[href*="/p/"]',
        'a[href*="/p/"][role]',
        'a[href*="/p/"]',
        'main a[href*="/p/"]',
    ];

    for (const sel of strategies) {
        try {
            const hrefs = await page.locator(sel).evaluateAll(
                (els, max) => els.slice(0, max).map(el => el.getAttribute('href')).filter(Boolean),
                MAX_CANDIDATES
            );
            const urls = hrefs
                .filter(h => h.includes('/p/'))
                .map(h => 'https://www.instagram.com' + h.split('?')[0]);
            if (urls.length > 0) return [...new Set(urls)]; // deduplicate
        } catch {}
    }
    return [];
}

// Get the datetime string from the post page
async function getPostDatetime(page) {
    // IG typically has <time datetime="2026-03-19T23:45:00.000Z"> in the post header
    try {
        const dt = await page.locator('time[datetime]').first().getAttribute('datetime', { timeout: 8000 });
        return dt || null;
    } catch { return null; }
}

// Get the best available image URL from the open post page
async function getPostThumb(page) {
    // 1. OG image tag is most reliable — available before full JS render
    try {
        const og = await page.locator('meta[property="og:image"]').getAttribute('content', { timeout: 6000 });
        if (og && og.startsWith('http')) return og;
    } catch {}

    // 2. Intercept the largest img inside the article
    const selectors = [
        'article div[role="button"] img',
        'article img[srcset]',
        'article img[src]',
    ];
    for (const sel of selectors) {
        try {
            const src = await page.locator(sel).first().getAttribute('src', { timeout: 4000 });
            if (src && src.startsWith('http')) return src;
        } catch {}
    }
    return null;
}

async function scrapeArtist(page, artist) {
    const profileUrl = `https://www.instagram.com/${artist.ig_handle}/`;
    process.stdout.write(`[${artist.id}] @${artist.ig_handle} `);

    // ── Step 1: Load profile ─────────────────────────────
    try {
        await goto(page, profileUrl);
    } catch (err) {
        console.log(`✗ profile load failed: ${err.message}`);
        return null;
    }

    // Check for login wall — shouldn't happen with a persisted session
    const loginWall = await page.locator('input[name="username"]').count().catch(() => 0);
    if (loginWall > 0) {
        console.log('✗ login wall — please log in first');
        return null;
    }

    // ── Step 2: Collect candidate post links ────────────
    const candidates = await getProfilePostUrls(page);
    if (candidates.length === 0) {
        console.log('✗ no post links found');
        return null;
    }

    // ── Step 3 & 4: Walk candidates, skip pinned/old posts ──
    let postUrl = null, datetime = null;
    let isToday = false, afterCutoff = false, timeLabel = '';

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        try {
            await goto(page, candidate);
        } catch (err) {
            console.log(`  [${i + 1}/${candidates.length}] load failed: ${err.message}`);
            continue;
        }

        const dt = await getPostDatetime(page);
        if (!dt) {
            console.log(`  [${i + 1}/${candidates.length}] no datetime, skipping`);
            continue;
        }

        const check = checkPostTime(dt);
        const label = new Date(dt).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'short',
            timeStyle: 'short',
        });

        if (!check.isToday) {
            // Pinned or simply old post — keep looking
            process.stdout.write(`  [${i + 1}] pinned/old (${label}), trying next… `);
            await sleep(800);
            continue;
        }

        // Found a post from today
        postUrl    = candidate;
        datetime   = dt;
        isToday    = check.isToday;
        afterCutoff = check.afterCutoff;
        timeLabel  = label;
        break;
    }

    if (!postUrl) {
        console.log('skip (no post from today found in top candidates)');
        return null;
    }

    if (!afterCutoff) {
        console.log(`skip (today but before 7 PM EST — ${timeLabel})`);
        return null;
    }

    // ── Step 5: Grab thumbnail ───────────────────────────
    const thumbUrl = await getPostThumb(page);

    console.log(`✓  ${timeLabel}  →  ${postUrl}`);
    return { postUrl, thumbUrl, datetime };
}

async function run() {
    console.log('═══════════════════════════════════════════════════');
    console.log(' sewer-showdown  ·  IG today-post scraper');
    console.log(' Saves posts published TODAY after 7 PM EST only');
    console.log(`' Session dir: ${SESSION_DIR}`);
    console.log('═══════════════════════════════════════════════════\n');

    // ── Launch headed persistent browser ────────────────
    const browser = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        viewport: { width: 1300, height: 920 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        slowMo: 120,   // slight slow-mo so pages feel natural
    });

    const page = await browser.newPage();

    // Dismiss any dialog that pops up
    page.on('dialog', d => d.dismiss().catch(() => {}));

    // ── Ensure logged in ─────────────────────────────────
    console.log('Opening Instagram…');
    try {
        await goto(page, 'https://www.instagram.com/');
    } catch {
        await sleep(3000);
    }

    // Look for login form — give the user 2 minutes to log in if needed
    const needsLogin = await page.locator('input[name="username"]').count().catch(() => 0);
    if (needsLogin > 0) {
        console.log('\n⚠  Not logged in — please log in in the browser window.');
        console.log('   You have up to 2 minutes. Session will be saved automatically.\n');
        try {
            await page.waitForSelector('svg[aria-label="Home"], a[href="/"][role="link"]', { timeout: 120000 });
        } catch {
            console.error('Timed out waiting for login. Run the script again after logging in.');
            await browser.close();
            await pool.end();
            process.exit(1);
        }
    }

    // Dismiss "Save login info" or "Turn on notifications" popups
    await sleep(1500);
    const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now")');
    if (await notNow.count() > 0) await notNow.first().click().catch(() => {});

    console.log('Logged in ✓\n');

    // ── Load artists — DB first, fall back to artists.json ───────────
    const dbArtists = await dbQuery(
        `SELECT id, ig_handle FROM artists
         WHERE is_active = TRUE AND ig_handle IS NOT NULL
         ORDER BY sort_order, id`
    );
    let artists = dbArtists ? dbArtists.rows : [];
    if (artists.length === 0) {
        console.log('DB unavailable — loading artists from data/artists.json\n');
        const jsonPath = path.join(__dirname, '..', '..', '..', 'data', 'artists.json');
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        artists = (raw.artists || [])
            .filter(a => a.instagram)
            .map(a => {
                let handle = null;
                try { handle = new URL(a.instagram).pathname.split('/').filter(Boolean)[0]; } catch {}
                return { id: a.id, ig_handle: handle };
            })
            .filter(a => a.ig_handle);
    }
    console.log(`${artists.length} artists to check\n`);

    let saved = 0, skipped = 0, errors = 0;
    const allResults = [];

    for (const artist of artists) {
        const result = await scrapeArtist(page, artist);

        if (!result) {
            skipped++;
        } else {
            allResults.push({ artistId: artist.id, handle: artist.ig_handle, ...result });
            await dbQuery(`
                INSERT INTO ig_posts (artist_id, post_url, manual_thumb_url, ig_posted_at, created_at, updated_at)
                VALUES ($1, $2, $3, $4, now(), now())
                ON CONFLICT (post_url) DO UPDATE SET
                    manual_thumb_url = COALESCE(EXCLUDED.manual_thumb_url, ig_posts.manual_thumb_url),
                    ig_posted_at     = COALESCE(EXCLUDED.ig_posted_at, ig_posts.ig_posted_at),
                    updated_at       = now()
            `, [artist.id, result.postUrl, result.thumbUrl, result.datetime || null]);
            saved++;
        }

        // Slow down between artists
        await sleep(jitter());
    }

    // Always write results to JSON regardless of DB status
    const outFile = path.join(__dirname, '../../../../scrape_results_today.json');
    fs.writeFileSync(outFile, JSON.stringify(allResults, null, 2));
    console.log(`\nResults saved to: ${outFile}`);

    await browser.close();
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(` Done:  ${saved} saved   ${skipped} skipped   ${errors} errors`);
    console.log(`═══════════════════════════════════════════════════`);
    if (pool) await pool.end();
}

run().catch(err => {
    console.error('[scrape-today] Fatal:', err.message);
    process.exit(1);
});
