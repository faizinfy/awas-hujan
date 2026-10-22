// Builds data/met-locations.json: every data.gov.my (MET Malaysia) forecast location with coordinates
// and state, so the page can find the MET location nearest to a clicked point.
// data.gov.my only gives location names, so each name is geocoded once here:
// Open-Meteo geocoding first, then Photon (OpenStreetMap data) as a fallback.
//
// Usage: node scripts/build-met-locations.mjs
// Behind a TLS-inspecting proxy, point NODE_EXTRA_CA_CERTS at the proxy's root certificate.

import { writeFile, mkdir } from 'node:fs/promises';
import https from 'node:https';

const OUT_FILE = new URL('../data/met-locations.json', import.meta.url);
const USER_AGENT = 'awas-hujan-build-script (https://github.com/faizinfy/awas-hujan)';
const PHOTON_DELAY_MS = 250; // be polite to the free Photon service

// Many place names exist in both halves of Malaysia (e.g. Langkawi, Baling, Kerian),
// so each lookup is limited to the half the location belongs to.
const REGIONS = {
  peninsula: { minLon: 99.5, maxLon: 104.7, minLat: 1.1, maxLat: 6.8 },
  borneo: { minLon: 109.5, maxLon: 119.5, minLat: 0.8, maxLat: 7.5 },
};

// data.gov.my IDs: St/Ds/Dv/Rc numbered 500+ are Sabah, Sarawak or Labuan; towns from Tn187 onwards are too.
function regionOf(id) {
  const num = Number(id.slice(2));
  const borneo = id.startsWith('Tn') ? num >= 187 : num >= 500;
  return borneo ? REGIONS.borneo : REGIONS.peninsula;
}

const inRegion = (region, lat, lon) =>
  lon >= region.minLon && lon <= region.maxLon && lat >= region.minLat && lat <= region.maxLat;

// Location ID prefixes used by data.gov.my.
const TYPES = { St: 'state', Ds: 'district', Dv: 'division', Tn: 'town', Rc: 'recreation' };

// Names that geocode badly as given.
const NAME_FIXES = {
  'WP Kuala Lumpur': 'Kuala Lumpur',
  'WP Putrajaya': 'Putrajaya',
  'WP Labuan': 'Labuan',
  'Cameron Highland': 'Cameron Highlands',
  'Barat Daya': 'Barat Daya, Pulau Pinang',
  'Timur Laut': 'Timur Laut, Pulau Pinang',
  'Seberang Perai Utara': 'Seberang Perai Utara, Pulau Pinang',
  'Seberang Perai Tengah': 'Seberang Perai Tengah, Pulau Pinang',
  'Seberang Perai Selatan': 'Seberang Perai Selatan, Pulau Pinang',
  'Gombak (Taman Perwira )': 'Taman Perwira, Gombak',
  'Tanah Rata - Brinchang': 'Tanah Rata',
  'Sungai Dua - Sungai Nibong': 'Sungai Dua, Pulau Pinang',
  'Bandar Tun Abdul Razak, Jengka': 'Bandar Tun Abdul Razak, Pahang',
  'Jalan Duta': 'Jalan Duta, Kuala Lumpur',
  'Taman Tunku Abdul Rahman': 'Pulau Gaya, Sabah',
  'Pusat Konservasi Gajah Kebangsaan': 'Kuala Gandah, Pahang',
  'Pedalaman': 'Keningau, Sabah', // Interior Division, administered from Keningau
  'Pantai Barat': 'Kota Kinabalu, Sabah', // West Coast Division
};

// One spelling per state/territory, matching the names MET uses in its warnings.
const STATE_NAMES = {
  'penang': 'Pulau Pinang', 'pulau pinang': 'Pulau Pinang',
  'malacca': 'Melaka', 'melaka': 'Melaka',
  'kuala lumpur': 'Kuala Lumpur', 'federal territory of kuala lumpur': 'Kuala Lumpur', 'wilayah persekutuan kuala lumpur': 'Kuala Lumpur',
  'putrajaya': 'Putrajaya', 'federal territory of putrajaya': 'Putrajaya', 'wilayah persekutuan putrajaya': 'Putrajaya',
  'labuan': 'Labuan', 'federal territory of labuan': 'Labuan', 'wilayah persekutuan labuan': 'Labuan',
  'negeri sembilan': 'Negeri Sembilan',
};
const KNOWN_STATES = ['Perlis', 'Kedah', 'Perak', 'Kelantan', 'Terengganu', 'Pahang', 'Selangor', 'Johor', 'Sabah', 'Sarawak'];

function normalizeState(state) {
  if (!state) return null;
  const key = state.toLowerCase().trim();
  return STATE_NAMES[key] ?? KNOWN_STATES.find(s => s.toLowerCase() === key) ?? state;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Uses node:https rather than fetch so it also runs on Node 16.
function getJson(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).href, redirectsLeft - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${url}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function fetchMetLocations() {
  const rows = await getJson('https://api.data.gov.my/weather/forecast?limit=5000');
  const byId = new Map();
  for (const { location } of rows) byId.set(location.location_id, location.location_name);
  return [...byId].map(([id, name]) => ({ id, name, type: TYPES[id.slice(0, 2)] ?? 'other' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function geocodeOpenMeteo(name, type, region) {
  const params = new URLSearchParams({ name, count: '20', language: 'en', format: 'json', countryCode: 'MY' });
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  const my = (data.results ?? []).filter(r => r.country_code === 'MY' && inRegion(region, r.latitude, r.longitude));
  if (!my.length) return null;
  const prefer = {
    district: r => r.feature_code === 'ADM2',
    division: r => r.feature_code === 'ADM2' || r.feature_code === 'ADM1',
    town: r => r.feature_code?.startsWith('PPL'),
  }[type];
  const preferred = prefer ? my.filter(prefer) : [];
  const pool = preferred.length ? preferred : my;
  // Several places can share a name; the most populous one is usually the one MET means.
  const r = pool.reduce((best, x) => ((x.population ?? 0) > (best.population ?? 0) ? x : best), pool[0]);
  return { lat: r.latitude, lon: r.longitude, state: r.admin1 ?? null };
}

async function geocodePhoton(name, type, region) {
  const bbox = [region.minLon, region.minLat, region.maxLon, region.maxLat].join(',');
  const params = new URLSearchParams({ q: name, limit: '5', bbox });
  const data = await getJson(`https://photon.komoot.io/api/?${params}`);
  await sleep(PHOTON_DELAY_MS);
  const my = (data.features ?? []).filter(f => f.properties.countrycode === 'MY');
  if (!my.length) return null;
  const prefer = {
    state: p => p.osm_value === 'state',
    district: p => ['district', 'county', 'state_district'].includes(p.osm_value),
    division: p => ['district', 'county', 'state_district', 'region'].includes(p.osm_value),
    town: p => ['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet'].includes(p.osm_value),
  }[type];
  const f = (prefer && my.find(x => prefer(x.properties))) || my[0];
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  // OSM files Kuala Lumpur as a city with no state.
  return { lat, lon, state: p.osm_value === 'state' ? p.name : p.state ?? p.city ?? null };
}

const round = n => Math.round(n * 10000) / 10000;

const locations = await fetchMetLocations();
console.log(`Geocoding ${locations.length} MET locations…`);

const out = [];
const failed = [];
for (const loc of locations) {
  const query = NAME_FIXES[loc.name] ?? loc.name;
  // Open-Meteo only matches plain place names, and has no state-level entries.
  const region = regionOf(loc.id);
  const tryOpenMeteo = loc.type !== 'state' && !query.includes(',');
  let geo = tryOpenMeteo ? await geocodeOpenMeteo(query, loc.type, region).catch(() => null) : null;
  if (!geo) geo = await geocodePhoton(query, loc.type, region).catch(err => { console.warn(`  ${loc.name}: ${err.message}`); return null; });
  if (!geo) { failed.push(loc); continue; }
  out.push({ id: loc.id, name: loc.name, type: loc.type, lat: round(geo.lat), lon: round(geo.lon), state: normalizeState(geo.state) });
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT_FILE, '[\n' + out.map(o => JSON.stringify(o)).join(',\n') + '\n]\n');
console.log(`Wrote ${out.length} locations to data/met-locations.json`);
if (failed.length) console.log(`Not found (${failed.length}): ${failed.map(f => `${f.id} ${f.name}`).join(', ')}`);
const states = [...new Set(out.map(o => o.state))].sort();
console.log(`States (${states.length}): ${states.join(', ')}`);
