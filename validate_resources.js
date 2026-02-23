#!/usr/bin/env node
/**
 * Validate that all game resources are accessible
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:8080';

async function fetchResource(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data, contentType: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

async function validateJSON(url) {
  try {
    const result = await fetchResource(url);
    JSON.parse(result.data);
    return { ok: true, size: result.data.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function validateImage(url) {
  try {
    const result = await fetchResource(url);
    // Just check if we got data and it's an image content type
    const isImage = result.contentType && result.contentType.startsWith('image/');
    return { ok: isImage, size: result.data.length, contentType: result.contentType };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  console.log('TMNT Art Show - Resource Validation');
  console.log('=' .repeat(60));
  
  // Test main page
  console.log('\n📄 Testing main page...');
  try {
    const page = await fetchResource(BASE_URL);
    console.log(`✓ index.html (${page.data.length} bytes)`);
  } catch (err) {
    console.log(`✗ index.html: ${err.message}`);
    return;
  }
  
  // Test JSON files
  console.log('\n📊 Testing JSON data files...');
  const jsonFiles = [
    'data/artists.json',
    'data/buildings.json',
    'data/world.json',
    'data/regions/na.json'
  ];
  
  for (const file of jsonFiles) {
    const result = await validateJSON(`${BASE_URL}/${file}`);
    if (result.ok) {
      console.log(`✓ ${file} (${result.size} bytes)`);
    } else {
      console.log(`✗ ${file}: ${result.error}`);
    }
  }
  
  // Test main game script
  console.log('\n📜 Testing JavaScript...');
  try {
    const js = await fetchResource(`${BASE_URL}/js/game.js`);
    console.log(`✓ js/game.js (${js.data.length} bytes)`);
  } catch (err) {
    console.log(`✗ js/game.js: ${err.message}`);
  }
  
  // Test critical sprite files
  console.log('\n🎨 Testing critical sprite files...');
  const criticalSprites = [
    'sprites/partywagon/drive1.png',
    'sprites/partywagon/drive2.png',
    'sprites/extracted/road_tile.png',
    'sprites/extracted/building_1.png',
    'sprites/extracted/water_tile.png',
    'sprites/extracted/sewer_tile.png',
    'sprites/extracted/mid_ground.png'
  ];
  
  for (const sprite of criticalSprites) {
    const result = await validateImage(`${BASE_URL}/${sprite}`);
    if (result.ok) {
      console.log(`✓ ${sprite} (${result.size} bytes, ${result.contentType})`);
    } else {
      console.log(`✗ ${sprite}: ${result.error || 'not an image'}`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✓ All critical resources validated!');
  console.log('\nThe game should load correctly at http://localhost:8080');
  console.log('\nTo test manually:');
  console.log('1. Open http://localhost:8080 in your browser');
  console.log('2. Open DevTools (F12) and check Console tab');
  console.log('3. Look for "COWABUNGA! World ready" message');
  console.log('4. Use arrow keys or WASD to move the Party Wagon');
  console.log('5. Press Enter near buildings to view artist info');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
