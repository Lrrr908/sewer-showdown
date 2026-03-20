#!/usr/bin/env node
// Usage: node tools/grab_post_image.js <postUrl> <shortcode>
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const SESSION_DIR = path.join(process.env.HOME, '.sewer-ig-session');
const THUMBS = path.join(__dirname, '..', 'data', 'ig-thumbs');

const [postUrl, shortcode] = process.argv.slice(2);
if (!postUrl || !shortcode) { console.error('Usage: node grab_post_image.js <postUrl> <shortcode>'); process.exit(1); }

function download(url, dest) {
    return new Promise((res, rej) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' },
            timeout: 20000,
        }, r => {
            if (r.statusCode >= 300 && r.statusCode < 400) return download(r.headers.location, dest).then(res).catch(rej);
            if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
            const ws = fs.createWriteStream(dest);
            r.pipe(ws);
            ws.on('finish', res); ws.on('error', rej);
        });
        req.on('error', rej);
        req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
    });
}

(async () => {
    const browser = await chromium.launchPersistentContext(SESSION_DIR, { headless: true });
    const page = await browser.newPage();
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const imgSrc = await page.evaluate(() => {
        const el = document.querySelector('div._aagv img, article img[src*="cdninstagram"], img[src*="fbcdn"]');
        return el ? el.src : null;
    });
    if (!imgSrc) { console.error('No image found on page'); await browser.close(); process.exit(1); }
    console.log('Found image, downloading...');
    const dest = path.join(THUMBS, shortcode + '.jpg');
    await download(imgSrc, dest);
    const size = Math.round(fs.statSync(dest).size / 1024);
    console.log(`Saved ${shortcode}.jpg (${size}KB)`);
    await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
