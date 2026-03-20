#!/usr/bin/env node
// Quick test — visits 3 posts, downloads images, shows resolution
// Usage: node server/src/db/test_thumb.js

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');
const { chromium } = require('playwright');

const ROOT       = path.resolve(__dirname, '../../../');
const THUMBS_DIR = path.join(ROOT, 'data/ig-thumbs');
const SESSION_DIR = path.join(process.env.HOME || '/tmp', '.sewer-ig-session');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// 3 test posts from different artists
const TEST_POSTS = [
    { artist: 'snztoys',    url: 'https://www.instagram.com/p/DRXSkGqApKb/' },
    { artist: 'tmntplus',   url: 'https://www.instagram.com/tmntplus/p/DUMW3JUgJmp/' },
    { artist: 'pizzaplazm', url: 'https://www.instagram.com/p/DWFWme_jo5g/' },
];

(async () => {
    console.log('Opening browser — you should see it appear on screen…\n');

    const browser = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        viewport: { width: 1080, height: 900 },   // fits on screen
        deviceScaleFactor: 2,                       // 2x = high-res images
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = browser.pages()[0] || await browser.newPage();

    // Helper to force window to front on Linux
    async function focusWindow() {
        try {
            await page.bringToFront();
            const { execSync } = require('child_process');
            const wid = execSync("DISPLAY=:0 wmctrl -l 2>/dev/null | grep -i 'chrome for testing' | awk '{print $1}'").toString().trim();
            if (wid) execSync(`DISPLAY=:0 wmctrl -ia ${wid} 2>/dev/null`);
        } catch {}
    }

    for (const post of TEST_POSTS) {
        console.log(`\n[${post.artist}] Navigating to ${post.url}`);
        await focusWindow();

        try {
            await page.goto(post.url, { waitUntil: 'load', timeout: 30000 });
        } catch {}

        // Wait for the post's main image — Instagram puts it in div._aagv
        try {
            await page.waitForSelector('div._aagv img', { timeout: 12000 });
        } catch {
            console.log('  ⚠  div._aagv img not found');
        }

        // Human-like pause
        await sleep(2000 + Math.random() * 1000);

        // Extract highest-res image from div._aagv (always THIS post's images)
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

        if (!result) {
            console.log('  ✗  No cdninstagram image found in article');
            continue;
        }

        console.log(`  Found image: ${result.width}px wide`);

        // Download it
        const sc = post.url.match(/\/p\/([^/]+)/)?.[1];
        const dest = path.join(THUMBS_DIR, `TEST_${post.artist}.jpg`);
        try {
            await downloadFile(result.url, dest);
            const { execSync } = require('child_process');
            const info = execSync(`file "${dest}"`).toString().trim().split(': ')[1];
            console.log(`  ✓  Saved to ${dest}`);
            console.log(`     ${info}`);
        } catch (e) {
            console.log(`  ✗  Download failed: ${e.message}`);
        }

        // Human-like gap between posts
        await sleep(3000 + Math.random() * 2000);
    }

    console.log('\nTest done. Check the 3 TEST_*.jpg files in data/ig-thumbs/');
    console.log('Browser stays open so you can inspect it. Close it manually or Ctrl+C here.');
})();
