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
const https  = require('https');
const http   = require('http');
const { chromium } = require('playwright');

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

function focusWindow() {
    try {
        const { execSync } = require('child_process');
        const wid = execSync("DISPLAY=:0 wmctrl -l 2>/dev/null | grep -i 'chrome for testing' | awk '{print $1}'").toString().trim();
        if (wid) execSync(`DISPLAY=:0 wmctrl -ir ${wid} -b remove,sticky 2>/dev/null; DISPLAY=:0 wmctrl -ia ${wid} 2>/dev/null`);
    } catch {}
}

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
const TARGET_DATE    = '2026-03-19';  // the event date (MM/DD doesn't matter, compare as string)
const WINDOW_START   = 18.917;        // 6:55 PM America/New_York
const WINDOW_END     = 19.75;         // 7:45 PM America/New_York
const DELAY_BASE_MS  = 2000;    // min pause between artists
const DELAY_JITTER   = 1500;    // up to +1.5 s random extra
const PAGE_TIMEOUT   = 25000;
const PAUSE_AFTER_MS = 1500;    // settle time after navigation
const MAX_CANDIDATES = 9;       // how many posts to check per profile (skips pinned)
// ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter()  { return DELAY_BASE_MS + Math.random() * DELAY_JITTER; }

// Returns { isTargetDate, inWindow, hourDecimal } in America/New_York time
// Target: March 19 2026, 6:55 PM – 7:45 PM EST
function checkPostTime(isoStr) {
    const post = new Date(isoStr);
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(post).reduce((o, x) => { o[x.type] = x.value; return o; }, {});

    // Build a comparable date string: YYYY-MM-DD
    const postDate = `${p.year}-${p.month}-${p.day}`;
    const isTargetDate = postDate === TARGET_DATE;
    const hourDecimal  = parseInt(p.hour) + parseInt(p.minute) / 60;
    const inWindow     = hourDecimal >= WINDOW_START && hourDecimal <= WINDOW_END;
    return { isTargetDate, inWindow, hourDecimal };
}

// Navigate to a URL and wait for it to settle
async function goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(PAUSE_AFTER_MS + Math.random() * 1000);
}

// Collect up to MAX_CANDIDATES post links from the profile grid.
// We gather several because the first slot(s) may be pinned (old) posts.

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

// Get the full-res image URL from the open post page
// div._aagv is Instagram's post image container — verified to give 1440x1800
async function getPostThumb(page) {
    try {
        await page.waitForSelector('div._aagv img', { timeout: 10000 });
    } catch {}

    // Extract highest-res from div._aagv (only THIS post's images, never suggested content)
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
    }).catch(() => null);

    if (result) {
        process.stdout.write(`[${result.width}px] `);
        return result.url;
    }

    // Fallback: og:image (640x640 square crop — last resort)
    try {
        const og = await page.locator('meta[property="og:image"]').getAttribute('content', { timeout: 4000 });
        if (og && og.startsWith('http')) { process.stdout.write('[og:fallback] '); return og; }
    } catch {}

    return null;
}

async function scrapeArtist(page, artist) {
    const profileUrl = `https://www.instagram.com/${artist.ig_handle}/`;
    process.stdout.write(`[${artist.id}] @${artist.ig_handle} `);

    // ── Step 1: Load profile ─────────────────────────────
    focusWindow();
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

        if (!check.isTargetDate) {
            // Pinned or old post — keep looking
            process.stdout.write(`  [${i + 1}] not Mar 19 (${label}), trying next… `);
            await sleep(800);
            continue;
        }

        if (!check.inWindow) {
            const h = check.hourDecimal.toFixed(2);
            console.log(`skip (today but outside 6:55–7:45 PM EST — ${label}, hour=${h})`);
            return null;
        }

        // Found a post from today within the window
        postUrl   = candidate;
        datetime  = dt;
        timeLabel = label;
        break;
    }

    if (!postUrl) {
        console.log('skip (no post from today found in top candidates)');
        return null;
    }

    // ── Step 5: Grab full-res image ──────────────────────
    const thumbUrl = await getPostThumb(page);

    // ── Step 6: Download image locally ──────────────────
    let localImagePath = null;
    if (thumbUrl) {
        const sc = shortcode(postUrl);
        if (sc) {
            const dest = path.join(THUMBS_DIR, sc + '.jpg');
            try {
                await downloadFile(thumbUrl, dest);
                const kb = Math.round(fs.statSync(dest).size / 1024);
                localImagePath = 'data/ig-thumbs/' + sc + '.jpg';
                process.stdout.write(`[saved ${kb}KB] `);
            } catch (e) {
                process.stdout.write(`[dl-fail: ${e.message}] `);
            }
        }
    }

    // ── Step 7: Update data/ig/<artistId>.json ───────────
    const jsonFile = path.join(IG_DIR, artist.id + '.json');
    if (fs.existsSync(jsonFile)) {
        try {
            const feed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
            const newItem = {
                postUrl,
                openUrl: postUrl,
                imageUrl: localImagePath || thumbUrl || '',
                postedAt: datetime,
                status: localImagePath ? 'local' : 'cdn',
            };
            // Remove any existing entry for this postUrl, then prepend
            feed.items = feed.items.filter(i => i.postUrl !== postUrl);
            feed.items.unshift(newItem);
            fs.writeFileSync(jsonFile, JSON.stringify(feed));
            process.stdout.write('[json ✓] ');
        } catch (e) {
            process.stdout.write(`[json-fail: ${e.message}] `);
        }
    }

    console.log(`✓  ${timeLabel}  →  ${postUrl}`);
    return { postUrl, thumbUrl: localImagePath || thumbUrl, datetime };
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
        viewport: { width: 1080, height: 900 },
        deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        slowMo: 80,
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
