#!/usr/bin/env node
// tools/scrape_feeds.js
// Playwright-based Instagram feed scraper.
// Visits public profiles in a headed browser with human-like delays.
//
// Usage:
//   node tools/scrape_feeds.js              (scrape all missing)
//   node tools/scrape_feeds.js handle1 ...  (scrape specific handles)

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const IG_DIR     = path.join(DATA_DIR, 'ig');
const THUMB_DIR  = path.join(DATA_DIR, 'ig-thumbs');
const ARTISTS_FILE = path.join(DATA_DIR, 'artists.json');

const MAX_POSTS = 3;

// ── Random delay helpers ─────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randBetween(min, max) {
    return min + Math.random() * (max - min);
}

// Gaussian-ish random: sum of 3 uniforms, normalized
function randGaussian(min, max) {
    const u = (Math.random() + Math.random() + Math.random()) / 3;
    return min + u * (max - min);
}

async function humanDelay(minSec, maxSec) {
    const ms = randGaussian(minSec * 1000, maxSec * 1000);
    await sleep(ms);
}

// ── Shuffle array ────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Download image ───────────────────────────────────────────

function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, {
            headers: {
                'Referer': 'https://www.instagram.com/',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            timeout: 30000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const ws = fs.createWriteStream(destPath);
            res.pipe(ws);
            ws.on('finish', () => { ws.close(); resolve(); });
            ws.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── Find missing artists ─────────────────────────────────────

function findMissingArtists() {
    const artists = JSON.parse(fs.readFileSync(ARTISTS_FILE, 'utf8')).artists;
    const igFiles = new Set(fs.readdirSync(IG_DIR).map(f => f.replace('.json', '')));

    const missing = [];
    for (const a of artists) {
        const url = a.instagram || '';
        const match = url.match(/instagram\.com\/([^\/\?]+)/);
        let handle = match ? match[1].replace(/\/$/, '').trim() : '';
        if (!handle || handle.includes(' ')) continue; // skip broken URLs

        if (!igFiles.has(a.id) && !igFiles.has(handle)) {
            missing.push({ id: a.id, handle: handle, name: a.name || a.id.toUpperCase() });
        }
    }
    return missing;
}

// ── Scrape one profile ───────────────────────────────────────

async function scrapeProfile(page, handle, artistId, artistName) {
    const url = 'https://www.instagram.com/' + handle + '/';
    console.log('  Navigating to ' + url);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
        console.log('  Navigation failed: ' + e.message);
        return null;
    }

    await humanDelay(2, 4);

    // Dismiss cookie/login dialogs
    try {
        const cookieBtn = page.locator('button:has-text("Allow"), button:has-text("Accept"), button:has-text("Decline optional")').first();
        if (await cookieBtn.isVisible({ timeout: 2000 })) {
            await cookieBtn.click();
            await humanDelay(1, 2);
        }
    } catch (_) {}

    try {
        const loginDismiss = page.locator('button:has-text("Not Now"), button:has-text("Not now"), [aria-label="Close"]').first();
        if (await loginDismiss.isVisible({ timeout: 2000 })) {
            await loginDismiss.click();
            await humanDelay(1, 2);
        }
    } catch (_) {}

    // Check if page loaded / profile exists
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes("Sorry, this page isn't available") || pageText.includes("Page Not Found")) {
        console.log('  Profile not found');
        return null;
    }
    if (pageText.includes('This account is private')) {
        console.log('  Profile is private');
        return null;
    }

    // Scroll down to trigger lazy loading of post images
    await page.mouse.move(randBetween(200, 600), randBetween(300, 500));
    await humanDelay(0.5, 1);
    await page.mouse.wheel(0, randBetween(300, 600));
    await humanDelay(2, 4);

    // Extract post links and images from the grid
    const posts = await page.evaluate(() => {
        const results = [];
        // IG grid: article with links containing /p/ shortcodes
        const links = document.querySelectorAll('a[href*="/p/"]');
        const seen = new Set();
        for (const link of links) {
            if (results.length >= 3) break;
            const href = link.getAttribute('href');
            const match = href.match(/\/p\/([^\/]+)/);
            if (!match) continue;
            const shortcode = match[1];
            if (seen.has(shortcode)) continue;
            seen.add(shortcode);

            // Find image inside this link
            const img = link.querySelector('img');
            const imageUrl = img ? (img.src || img.getAttribute('srcset') || '').split(',')[0].split(' ')[0] : '';

            results.push({ shortcode, imageUrl, postUrl: 'https://www.instagram.com/p/' + shortcode + '/' });
        }
        return results;
    });

    if (posts.length === 0) {
        // Fallback: try getting images from any img in the main content
        const fallbackPosts = await page.evaluate(() => {
            const results = [];
            const imgs = document.querySelectorAll('article img, main img');
            for (const img of imgs) {
                if (results.length >= 3) break;
                const src = img.src || '';
                if (!src || src.includes('profile') || src.includes('150x150')) continue;
                // Try to find parent link
                const link = img.closest('a[href*="/p/"]');
                if (!link) continue;
                const href = link.getAttribute('href');
                const match = href.match(/\/p\/([^\/]+)/);
                if (!match) continue;
                results.push({ shortcode: match[1], imageUrl: src, postUrl: 'https://www.instagram.com/p/' + match[1] + '/' });
            }
            return results;
        });
        if (fallbackPosts.length > 0) posts.push(...fallbackPosts);
    }

    console.log('  Found ' + posts.length + ' posts');
    if (posts.length === 0) return null;

    // Download thumbnails
    const now = new Date().toISOString();
    const items = [];

    for (const post of posts.slice(0, MAX_POSTS)) {
        const thumbPath = path.join(THUMB_DIR, post.shortcode + '.jpg');
        const relThumbPath = 'data/ig-thumbs/' + post.shortcode + '.jpg';

        if (post.imageUrl && !fs.existsSync(thumbPath)) {
            try {
                console.log('    Downloading ' + post.shortcode + '.jpg');
                await downloadImage(post.imageUrl, thumbPath);
                await humanDelay(1, 3);
            } catch (e) {
                console.log('    Download failed: ' + e.message);
            }
        }

        items.push({
            postUrl: post.postUrl,
            authorName: artistName,
            authorUrl: 'https://www.instagram.com/' + handle + '/',
            title: null,
            imageUrl: fs.existsSync(thumbPath) ? relThumbPath : post.imageUrl,
            openUrl: post.postUrl,
            status: fs.existsSync(thumbPath) ? 'local' : 'cdn',
            fetchedAt: now
        });
    }

    return {
        artistId: artistId,
        artistName: artistName,
        updatedAt: now,
        items: items
    };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(IG_DIR)) fs.mkdirSync(IG_DIR, { recursive: true });
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

    // Determine which artists to scrape
    let targets;
    if (process.argv.length > 2) {
        targets = process.argv.slice(2).map(h => ({ id: h, handle: h, name: h.toUpperCase() }));
    } else {
        targets = findMissingArtists();
    }

    if (targets.length === 0) {
        console.log('No missing artists to scrape.');
        return;
    }

    shuffle(targets);
    console.log('=== Instagram Feed Scraper ===');
    console.log('Targets: ' + targets.length + ' artists (shuffled)');
    console.log('');

    // Pick a random realistic viewport
    const viewports = [
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1920, height: 1080 },
    ];
    const vp = viewports[Math.floor(Math.random() * viewports.length)];

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
        ]
    });

    const context = await browser.newContext({
        viewport: vp,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Block unnecessary resources to reduce fingerprint and speed up
    await context.route('**/*.{woff,woff2,ttf}', route => route.abort());

    const page = await context.newPage();

    let success = 0, failed = 0, skipped = 0;

    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        console.log('[' + (i + 1) + '/' + targets.length + '] ' + t.handle + ' (' + t.name + ')');

        const feed = await scrapeProfile(page, t.handle, t.id, t.name);

        if (feed && feed.items.length > 0) {
            const outPath = path.join(IG_DIR, t.id + '.json');
            fs.writeFileSync(outPath, JSON.stringify(feed, null, 2) + '\n');
            console.log('  Saved ' + feed.items.length + ' items -> ' + t.id + '.json');
            success++;
        } else {
            console.log('  SKIPPED (no posts found or profile unavailable)');
            skipped++;
        }

        // Random delay before next artist
        if (i < targets.length - 1) {
            const delaySec = randGaussian(20, 45);
            console.log('  Waiting ' + Math.round(delaySec) + 's...\n');
            await sleep(delaySec * 1000);
        }
    }

    await browser.close();

    console.log('\n=== Summary ===');
    console.log('  Success: ' + success);
    console.log('  Skipped: ' + skipped);
    console.log('  Failed:  ' + failed);
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
