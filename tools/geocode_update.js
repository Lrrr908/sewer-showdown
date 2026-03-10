#!/usr/bin/env node
'use strict';
const xlsx = require('xlsx');
const fs = require('fs');
const https = require('https');

const ARTISTS_JSON   = '/home/beast/sewer-showdown/data/artists.json';
const LOCATIONS_JSON = '/home/beast/sewer-showdown/data/artist_locations.json';
const XLSX_FILE      = '/home/beast/Downloads/sewer showdown final list.xlsx';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nominatim(query) {
    return new Promise((resolve) => {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
        const req = https.get(url, { headers: { 'User-Agent': 'sewer-showdown-tools/1.0' } }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j && j[0]) resolve({ lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), display: j[0].display_name });
                    else resolve(null);
                } catch(e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
    });
}

// Derive 2-letter country from the location string
function guessCountry(locStr) {
    const l = locStr.toLowerCase();
    if (l.includes(', usa') || l.includes(', us') || l.includes('united states')) return 'US';
    if (l.includes('canada')) return 'CA';
    if (l.includes('mexico')) return 'MX';
    if (l.includes('brazil') || l.includes('brasil')) return 'BR';
    if (l.includes('argentina')) return 'AR';
    if (l.includes('chile')) return 'CL';
    if (l.includes('colombia') || l.includes('columbia')) return 'CO';
    if (l.includes('peru')) return 'PE';
    if (l.includes('ecuador')) return 'EC';
    if (l.includes('puerto rico')) return 'PR';
    if (l.includes('uk') || l.includes('england') || l.includes('scotland') || l.includes('wales') || l.includes('united kingdom')) return 'GB';
    if (l.includes('germany') || l.includes('deutschland')) return 'DE';
    if (l.includes('france')) return 'FR';
    if (l.includes('spain') || l.includes('españa')) return 'ES';
    if (l.includes('italy') || l.includes('italia')) return 'IT';
    if (l.includes('portugal')) return 'PT';
    if (l.includes('belgium') || l.includes('belgique')) return 'BE';
    if (l.includes('netherlands') || l.includes('holland')) return 'NL';
    if (l.includes('switzerland') || l.includes('suisse')) return 'CH';
    if (l.includes('croatia')) return 'HR';
    if (l.includes('sweden') || l.includes('sverige')) return 'SE';
    if (l.includes('japan')) return 'JP';
    if (l.includes('china')) return 'CN';
    if (l.includes('indonesia')) return 'ID';
    if (l.includes('australia') || l.includes('austrailia')) return 'AU';
    return 'XX';
}

// Derive regionId from country
function countryToRegion(country) {
    const na = new Set(['US','CA','MX','PR']);
    const sa = new Set(['BR','AR','CL','CO','PE','EC','VE','BO','PY','UY']);
    const eu = new Set(['GB','DE','FR','ES','IT','PT','BE','NL','CH','SE','NO','DK','FI','AT','PL','HR','CZ','RO','HU','GR','RS']);
    const asia = new Set(['JP','CN','KR','TW','SG','ID','IN','TH','VN','MY','PH']);
    const oce = new Set(['AU','NZ']);
    if (na.has(country)) return 'na';
    if (sa.has(country)) return 'sa';
    if (eu.has(country)) return 'eu';
    if (asia.has(country)) return 'asia';
    if (oce.has(country)) return 'oce';
    return 'na'; // default
}

async function main() {
    // Read Excel
    const wb = xlsx.readFile(XLSX_FILE);
    const raw = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const xlsxArtists = [];
    for (const row of raw) {
        const handle = (row[0]||'').toString().trim();
        const city   = (row[1]||'').toString().trim();
        if (handle) xlsxArtists.push({ handle, city });
    }
    console.log('Excel rows:', xlsxArtists.length);

    // Load existing locations
    const locData = JSON.parse(fs.readFileSync(LOCATIONS_JSON, 'utf8'));
    const locByHandle = {};
    for (const l of locData.locations) locByHandle[l.handle] = l;

    // Process each artist
    let geocodeCount = 0;
    for (const xa of xlsxArtists) {
        const existing = locByHandle[xa.handle];
        const cityPart = xa.city.split(',')[0].trim(); // just the city name
        const country  = guessCountry(xa.city);

        const needsGeocode = !existing ||
            (existing.city || '').toLowerCase() !== cityPart.toLowerCase();

        if (needsGeocode && xa.city) {
            process.stdout.write('  Geocoding ' + xa.handle + ' (' + xa.city + ')... ');
            const result = await nominatim(xa.city);
            if (result) {
                locByHandle[xa.handle] = {
                    handle: xa.handle,
                    city: cityPart,
                    country: country,
                    lat: Math.round(result.lat * 100) / 100,
                    lon: Math.round(result.lon * 100) / 100
                };
                console.log('OK -> ' + locByHandle[xa.handle].lat + ',' + locByHandle[xa.handle].lon);
                geocodeCount++;
            } else {
                console.log('NOT FOUND - keeping existing or null');
                if (!existing) {
                    locByHandle[xa.handle] = { handle: xa.handle, city: cityPart, country, lat: null, lon: null };
                } else {
                    existing.city = cityPart;
                    existing.country = country;
                }
            }
            await sleep(1200); // Nominatim rate limit: 1 req/sec
        } else if (existing && cityPart && existing.city !== cityPart) {
            existing.city = cityPart;
            existing.country = country;
        }
    }

    // Write updated locations
    const xlsxHandles = new Set(xlsxArtists.map(a => a.handle));
    const newLocations = xlsxArtists.map(xa => locByHandle[xa.handle]).filter(Boolean);
    locData.locations = newLocations;
    fs.writeFileSync(LOCATIONS_JSON, JSON.stringify(locData, null, 2) + '\n');
    console.log('\nUpdated artist_locations.json (' + newLocations.length + ' entries, ' + geocodeCount + ' geocoded)');
}

main().catch(e => { console.error(e); process.exit(1); });
