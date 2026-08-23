// HOLE — a shared world with one purpose: dig all of it.
// First-person voxel digging. Sell what you dig. Buy a better shovel. Repeat.
//
// Built to face 100k+ concurrent diggers on a 1.775-quadrillion-block planet:
// every gameplay event is interest-scoped to a 3x3-sector neighborhood, world
// saves are async + sharded, and only a light 5s heartbeat is truly global.
//
// Voxels: 0 air, 1 grass, 2 dirt, 3 stone, 4 coal, 5 iron, 6 gold, 7 diamond, 8 bedrock,
//         9 tree trunk, 10 leaves (trees are diggable but don't count as "earth"),
//         11 sand, 12 copper, 13 silver, 14 amethyst, 15 fossil, 16 tombstone

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const BOOT_TIME = Date.now();

const PORT = process.env.PORT || 3013;

// ---------------------------------------------------------------- world
const WX = 118000, WY = 96, WZ = 118000; // right-sized planet
const TOTAL_DIGGABLE = 999000000000;     // the official figure: 999 billion blocks
const CHUNK = 16;
const CX = WX / CHUNK, CY = WY / CHUNK, CZ = WZ / CHUNK;
const SECTOR = 500;                          // one "site" = 500×500 columns
const SECTORS_X = WX / SECTOR, SECTORS_Z = WZ / SECTOR; // 236 × 236 sites
const SEED = 8341;
const SURF_BASE = 72;
const DAY_LEN = 2400; // one full day/night cycle = 40 real minutes, shared by everyone
const TORCH_CAP = 100000;
const TOMB_CAP = 20000;

const DATA_DIR = process.env.HOLE_DATA || path.join(__dirname, 'data');
const CHUNK_DIR = path.join(DATA_DIR, 'chunks');
const META_FILE = path.join(DATA_DIR, 'meta.json');
fs.mkdirSync(CHUNK_DIR, { recursive: true });

// imul-based so coordinates in the millions stay exact (plain * loses low bits)
function hash3(x, y, z) {
  let h = Math.imul(SEED ^ 0x9e3779b9, 2246822519);
  h = Math.imul(h ^ Math.imul(x | 0, 374761393), 668265263);
  h = Math.imul(h ^ Math.imul(y | 0, 1274126177), 461845907);
  h = Math.imul(h ^ Math.imul(z | 0, 1103515245), 668265263);
  h ^= h >>> 15; h = Math.imul(h, 2654435761); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// smooth rolling surface height via bilinear-interpolated grid noise
function surfaceHeight(x, z) {
  const s = 8;
  const gx = Math.floor(x / s), gz = Math.floor(z / s);
  const fx = (x - gx * s) / s, fz = (z - gz * s) / s;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash3(gx, 77, gz), b = hash3(gx + 1, 77, gz);
  const c = hash3(gx, 77, gz + 1), d = hash3(gx + 1, 77, gz + 1);
  const n = a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  return SURF_BASE + Math.round((n - 0.5) * 7);
}

// smooth regional noise (units of `scale` sites) — drives biomes AND the map
function regionNoise(x, z, scale, salt) {
  const gx = Math.floor(x / scale), gz = Math.floor(z / scale);
  const fx = (x - gx * scale) / scale, fz = (z - gz * scale) / scale;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash3(gx, salt, gz), b = hash3(gx + 1, salt, gz);
  const c = hash3(gx, salt, gz + 1), d = hash3(gx + 1, salt, gz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

// biomes: 0 swamp (water + islands) · 1 desert (palms) · 2 dunes ·
//         3 dry grassland · 4 grassland · 5 parkland · 6 forest
const WATER_Y = 71; // standing-water level in swamps
function biomeAt(x, z) {
  const n = regionNoise(x / SECTOR, z / SECTOR, 28, 909) * 0.68
          + regionNoise(x / SECTOR, z / SECTOR, 9, 707) * 0.32;
  if (n < 0.24) return 0;
  if (n < 0.32) return 1;
  if (n < 0.40) return 2;
  if (n < 0.48) return 3;
  if (n < 0.62) return 4;
  if (n < 0.74) return 5;
  return 6;
}
const biomeCache = new Map(); // biome is constant over ~14km — cache per 256-block cell
function biomeCell(x, z) {
  const k = (x >> 8) * 1000000 + (z >> 8);
  let b = biomeCache.get(k);
  if (b === undefined) {
    b = biomeAt((x >> 8 << 8) + 128, (z >> 8 << 8) + 128);
    if (biomeCache.size > 4096) biomeCache.clear();
    biomeCache.set(k, b);
  }
  return b;
}
const TREE_DENSITY = [0.001, 0.0008, 0.0012, 0.002, 0.006, 0.0045, 0.02];

// swamps sit in a 4-block depression; everything terrain-side uses this height
function effSurf(x, z) {
  return surfaceHeight(x, z) - (biomeCell(x, z) === 0 ? 4 : 0);
}

// returns trunk height if a tree grows in this column, else 0
function treeAt(x, z) {
  if (x < 3 || z < 3 || x >= WX - 3 || z >= WZ - 3) return 0;
  const b = biomeCell(x, z);
  if (hash3(x, 999, z) >= TREE_DENSITY[b]) return 0;
  if (b === 0 && effSurf(x, z) < WATER_Y) return 0; // swamp trees only on islands
  if (b === 1) return 6 + Math.floor(hash3(x, 555, z) * 3); // desert palms grow tall
  return 4 + Math.floor(hash3(x, 555, z) * 3);
}

// smooth 3D noise: trilinear interpolation over a coarse hash grid
function noise3(x, y, z, s) {
  const gx = Math.floor(x / s), gy = Math.floor(y / s), gz = Math.floor(z / s);
  const fx = (x - gx * s) / s, fy = (y - gy * s) / s, fz = (z - gz * s) / s;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (dx, dy, dz) => hash3(gx + dx, (gy + dy) * 131 + 7, gz + dz);
  const a = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * sx;
  const b = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * sx;
  const c = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * sx;
  const d = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * sx;
  return (a + (b - a) * sz) + ((c + (d - c) * sz) - (a + (b - a) * sz)) * sy;
}

// spaghetti caves: the intersection of two noise level-surfaces makes tunnels
function isCave(x, y, z, d) {
  if (d <= 6 || y <= 4) return false; // crust stays intact, bedrock stays sealed
  const n1 = noise3(x, y * 2, z, 14);
  if (Math.abs(n1 - 0.5) > 0.055) return false;
  const n2 = noise3(x + 9999, y * 2, z - 9999, 14);
  return Math.abs(n2 - 0.5) < 0.055;
}

// somewhere near the bottom of some sectors: a sealed 3×3×3 door. DO NOT DIG.
function doorAt(x, y, z) {
  if (y < 2 || y > 4) return false;
  const cx = Math.floor(x / 512), cz = Math.floor(z / 512);
  if (hash3(cx, 424242, cz) >= 0.03) return false;
  const dx = 40 + Math.floor(hash3(cx, 71, cz) * 430);
  const dz = 40 + Math.floor(hash3(cx, 72, cz) * 430);
  return Math.abs(x - (cx * 512 + dx)) <= 1 && Math.abs(z - (cz * 512 + dz)) <= 1;
}

function genVoxel(x, y, z) {
  const biome = biomeCell(x, z);
  const surf = effSurf(x, z);
  if (y > surf) {
    const h0 = treeAt(x, z);
    if (h0 && y <= surf + h0) return 9;      // trunk
    for (let tz = z - 2; tz <= z + 2; tz++)
      for (let tx = x - 2; tx <= x + 2; tx++) {
        const h = treeAt(tx, tz);
        if (!h) continue;
        const cy = effSurf(tx, tz) + h;
        const dx = x - tx, dy = y - cy, dz = z - tz;
        if (dx * dx + dz * dz + dy * dy * 1.6 <= 4.2 + (hash3(x, y, z) - 0.5) * 1.5)
          return 10;                          // canopy
      }
    if (biome === 0 && y <= WATER_Y) return 19; // standing swamp water
    return 0;
  }
  if (y < 2) return 8;              // bedrock shell — the only thing we leave behind
  const sandy = biome <= 2 // swamp islands, deserts and dunes are sand, full stop
    || (biome === 3 && hash3(Math.floor(x / 6), 424, Math.floor(z / 6)) < 0.45)
    || (surf <= SURF_BASE - 1 && hash3(Math.floor(x / 6), 424, Math.floor(z / 6)) < 0.3);
  if (y === surf) return sandy ? 11 : 1;   // grass, or sand
  const d = surf - y;
  if (d <= 3) return sandy ? 11 : 2;       // topsoil
  if (doorAt(x, y, z)) return 18;          // the door. do not dig.
  if (isCave(x, y, z, d)) return 0;        // natural caves
  const r = hash3(x, y, z);
  if (d > 4 && hash3(x ^ 3313, y, z ^ 7717) < 0.0002) return 21; // buried company memo
  if (d > 20 && r < 0.0004) return 17;     // company artifact — very rare
  if (d > 10 && r < 0.0012) return 15;     // fossil (rare, any depth) ~0.1%
  if (d > 55 && r < 0.006) return 7;       // diamond  ~0.5%
  if (d > 45 && r < 0.014) return 14;      // amethyst ~0.8%
  if (d > 35 && r < 0.028) return 6;       // gold     ~1.4%
  if (d > 25 && r < 0.048) return 13;      // silver   ~2%
  if (d > 15 && r < 0.08) return 5;        // iron     ~3.2%
  if (d > 6 && r < 0.12) return 12;        // copper   ~4%
  if (d > 4 && r < 0.17) return 4;         // coal     ~5%
  return 3;                                // stone
}

// ---------------------------------------------------------------- chunk store
// Modified chunks are sharded across subdirectories — a single flat directory
// dies long before a planet's worth of files does.
const chunks = new Map(); // "cx,cy,cz" -> { data: Uint8Array(4096), dirty, touch }
const ckey = (cx, cy, cz) => cx + ',' + cy + ',' + cz;
const cdirOf = (cx, cz) => path.join(CHUNK_DIR, (cx >> 6) + '_' + (cz >> 6));
const cfile = (cx, cy, cz) => path.join(cdirOf(+cx, +cz), cx + '_' + cy + '_' + cz + '.bin');
const legacyCfile = (cx, cy, cz) => path.join(CHUNK_DIR, cx + '_' + cy + '_' + cz + '.bin');

function getChunk(cx, cy, cz) {
  const key = ckey(cx, cy, cz);
  let c = chunks.get(key);
  if (c) { c.touch = Date.now(); return c; }
  let data = null;
  const file = cfile(cx, cy, cz);
  if (fs.existsSync(file)) data = new Uint8Array(fs.readFileSync(file));
  else {
    const legacy = legacyCfile(cx, cy, cz);
    if (fs.existsSync(legacy)) data = new Uint8Array(fs.readFileSync(legacy));
  }
  if (!data) {
    data = new Uint8Array(CHUNK * CHUNK * CHUNK);
    const bx = cx * CHUNK, by = cy * CHUNK, bz = cz * CHUNK;
    if (by <= SURF_BASE + 11) { // fully-empty sky chunks skip the generator
      let i = 0;
      for (let y = 0; y < CHUNK; y++)
        for (let z = 0; z < CHUNK; z++)
          for (let x = 0; x < CHUNK; x++)
            data[i++] = genVoxel(bx + x, by + y, bz + z);
    }
  }
  const cc = { data, dirty: false, touch: Date.now() };
  chunks.set(key, cc);
  return cc;
}

// keep memory bounded: evict cold CLEAN chunks (dirty ones wait for the saver)
setInterval(() => {
  if (chunks.size <= 4000) return;
  const cold = [...chunks.entries()]
    .filter(([, c]) => !c.dirty)
    .sort((a, b) => a[1].touch - b[1].touch);
  for (const [key] of cold) {
    if (chunks.size <= 3000) break;
    chunks.delete(key);
  }
}, 30000);

function inWorld(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < WX && y < WY && z < WZ; }

function getVoxel(x, y, z) {
  if (y >= WY) return 0; // open sky above the world ceiling
  if (!inWorld(x, y, z)) return 8;
  const c = getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
  return c.data[((y % CHUNK) * CHUNK + (z % CHUNK)) * CHUNK + (x % CHUNK)];
}

function setVoxel(x, y, z, v) {
  if (!inWorld(x, y, z)) return;
  const c = getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
  c.data[((y % CHUNK) * CHUNK + (z % CHUNK)) * CHUNK + (x % CHUNK)] = v;
  c.dirty = true;
}

// ---------------------------------------------------------------- persistent meta
let meta = { globalDug: 0, totalDiggable: 0, board: {}, profiles: {}, torches: [], tombs: [] };
try {
  const m = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  meta = Object.assign(meta, m);
} catch (e) { /* fresh planet */ }
if (!Array.isArray(meta.torches)) meta.torches = [];
if (!Array.isArray(meta.tombs)) meta.tombs = [];
if (!Array.isArray(meta.crates)) meta.crates = []; // one-way underground caches
if (!Array.isArray(meta.ladders)) meta.ladders = []; // wall-mounted rungs, shared like torches
if (!meta.earned || typeof meta.earned !== 'object') meta.earned = {};
if (!meta.auth || typeof meta.auth !== 'object') meta.auth = {};         // name → claim-token hash
if (!meta.digBySite || typeof meta.digBySite !== 'object') meta.digBySite = {}; // "sx,sz" → blocks removed
// the company tracks everything
meta.stats = Object.assign({
  boots: 0, joins: 0, peak: 0, seconds: 0,
  deaths: 0, deathsFall: 0, deathsDyn: 0, deathsGaveUp: 0,
  gravesRobbed: 0, graveValueRobbed: 0, graveValueBuried: 0,
  digsByPlayers: 0, digsByDrones: 0, blocksBlasted: 0,
  dynPlaced: 0, torchesPlaced: 0, torchesAcquired: 0,
  shovelsIssued: 0, packsIssued: 0,
  treesFelled: 0, tombsDug: 0, dronesDeployed: 0,
  cratesSold: 0, cratesPlaced: 0, cratesSmashed: 0, blocksCrated: 0,
  laddersSold: 0, laddersPlaced: 0,
  memosFound: 0, loreSeen: {},
  rlDigBlocked: 0, tpBlocked: 0, moneyClamped: 0,
  deepestEver: 0,
  byBlock: {}, countries: {}, geoCache: {}, sites: {}, views: {},
}, meta.stats || {});
meta.stats.boots++;

function bumpBlock(v) { meta.stats.byBlock[v] = (meta.stats.byBlock[v] || 0) + 1; }

// best-effort geo: IPs are hashed before storage; lookups may silently fail
function noteGeo(rawIp) {
  try {
    if (!rawIp) return;
    const ip = String(rawIp).replace('::ffff:', '');
    const priv = /^(10\.|192\.168|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.|::1|fe80|fc|fd)/.test(ip);
    const key = crypto.createHash('sha1').update(ip).digest('hex').slice(0, 12);
    if (meta.stats.geoCache[key] && meta.stats.geoCache[key] !== 'pending') return;
    meta.stats.geoCache[key] = 'pending';
    const done = (country) => {
      meta.stats.geoCache[key] = country;
      meta.stats.countries[country] = (meta.stats.countries[country] || 0) + 1;
    };
    if (priv) return done('Local Network');
    const req = http.get('http://ip-api.com/json/' + ip + '?fields=country', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { done(JSON.parse(body).country || 'Unknown'); } catch (e) { done('Unknown'); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); done('Unknown'); });
    req.on('error', () => done('Unknown'));
  } catch (e) { /* geo is a luxury */ }
}
meta.totalDiggable = TOTAL_DIGGABLE; // official goal, fixed
// drop objects stranded outside the (re)sized world
meta.torches = meta.torches.filter(t => t.x >= 0 && t.z >= 0 && t.x < WX && t.z < WZ);
meta.tombs = meta.tombs.filter(t => t.x >= 0 && t.z >= 0 && t.x < WX && t.z < WZ);
meta.crates = meta.crates.filter(c => c.x >= 0 && c.z >= 0 && c.x < WX && c.z < WZ);
meta.ladders = meta.ladders.filter(l => l.x >= 0 && l.z >= 0 && l.x < WX && l.z < WZ);
// ---------------------------------------------------------------- name policy
// Slur names get refused at the door. Leetspeak is normalized (D1GG3R-style
// evasions), non-letters stripped, repeats collapsed, then matched against a
// short list of unambiguous stems plus exact-only entries (to avoid the
// Scunthorpe problem on short ambiguous words).
const LEET_MAP = { 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 0: 'o', 8: 'b', 6: 'g', 9: 'g' };
const BAD_SUBSTR = ['nigger', 'nigga', 'niglet', 'faggot', 'kike', 'chink', 'wetback',
  'beaner', 'tranny', 'raghead', 'towelhead', 'cunt', 'hitler', 'swastika', 'rapist'];
const BAD_EXACT = ['fag', 'fags', 'spic', 'coon', 'coons', 'gook', 'paki', 'nig', 'nigs', 'kkk'];
function isBannedName(raw) {
  let t = String(raw).toLowerCase().replace(/[0-9]/g, (c) => LEET_MAP[c] || '');
  t = t.replace(/[^a-z]/g, '');
  const collapsed = t.replace(/(.)\1+/g, '$1');
  if (BAD_SUBSTR.some((b) => t.includes(b) || collapsed.includes(b))) return true;
  return BAD_EXACT.includes(t) || BAD_EXACT.includes(collapsed);
}


// scrub any slur-names that got in before the handbook existed
for (const store of [meta.profiles, meta.auth, meta.board, meta.earned]) {
  if (store) for (const k of Object.keys(store)) if (isBannedName(k)) delete store[k];
}
meta.tombs.forEach((t) => { if (isBannedName(t.name)) t.name = 'REDACTED'; });

// async, atomic saves — never block the event loop on the world's disk
let saving = false;
async function saveWorld() {
  if (saving) return 0;
  saving = true;
  let flushed = 0;
  try {
    meta.hired = [...bots.values()].filter(b => b.hired)
      .map(b => ({ owner: b.owner, x: b.x, y: b.y, z: b.z }));
    const dirty = [];
    for (const [key, c] of chunks)
      if (c.dirty) { c.dirty = false; dirty.push([key, Buffer.from(c.data)]); }
    for (const [key, buf] of dirty) {
      const [cx, cy, cz] = key.split(',');
      await fs.promises.mkdir(cdirOf(+cx, +cz), { recursive: true });
      await fs.promises.writeFile(cfile(cx, cy, cz), buf);
      flushed++;
    }
    await fs.promises.writeFile(META_FILE + '.tmp', JSON.stringify(meta));
    await fs.promises.rename(META_FILE + '.tmp', META_FILE);
  } catch (e) {
    console.error('save error:', e.message);
  } finally {
    saving = false;
  }
  return flushed;
}
setInterval(saveWorld, 10000);

function saveWorldSync() { // exit path only
  try {
    meta.hired = [...bots.values()].filter(b => b.hired)
      .map(b => ({ owner: b.owner, x: b.x, y: b.y, z: b.z }));
  } catch (e) { /* bots not yet defined at some call sites */ }
  let flushed = 0;
  for (const [key, c] of chunks) {
    if (!c.dirty) continue;
    const [cx, cy, cz] = key.split(',');
    fs.mkdirSync(cdirOf(+cx, +cz), { recursive: true });
    fs.writeFileSync(cfile(cx, cy, cz), Buffer.from(c.data));
    c.dirty = false;
    flushed++;
  }
  fs.writeFileSync(META_FILE, JSON.stringify(meta));
  return flushed;
}

// ---------------------------------------------------------------- sectors & interest
// Everything a player can actually see lives within their 3×3 sector
// neighborhood — so that's exactly how far gameplay events travel.
const players = new Map();  // id -> player
const bySector = new Map(); // "sx,sz" -> Set<player>
let nextId = 1;

const skeyOf = (x, z) => Math.floor(x / SECTOR) + ',' + Math.floor(z / SECTOR);
const sectorOf = (x, z) => [Math.floor(x / SECTOR), Math.floor(z / SECTOR)];
const siteCode = (sx, sz) => String(sx).padStart(4, '0') + '-' + String(sz).padStart(4, '0');

function nineKeys(skey) {
  const [sx, sz] = skey.split(',').map(Number);
  const out = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) out.push((sx + dx) + ',' + (sz + dz));
  return out;
}

function sectorAdd(p) {
  const k = skeyOf(p.x, p.z);
  p.skey = k;
  let s = bySector.get(k);
  if (!s) bySector.set(k, s = new Set());
  s.add(p);
}
function sectorRemove(p) {
  const s = bySector.get(p.skey);
  if (s) { s.delete(p); if (!s.size) bySector.delete(p.skey); }
}

function broadcastNear(x, z, msg, exceptId) {
  const str = JSON.stringify(msg);
  for (const k of nineKeys(skeyOf(x, z))) {
    const s = bySector.get(k);
    if (!s) continue;
    for (const p of s)
      if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(str);
  }
}

function broadcastAll(msg, exceptId) {
  const str = JSON.stringify(msg);
  for (const p of players.values())
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(str);
}

const publicPlayer = (p) => ({
  id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, hue: p.hue,
  rank: rankOf((meta.profiles[p.name] || {}).jobsDone),
});

function activeSites() {
  return [...bySector.entries()]
    .map(([k, s]) => ({ code: k.split(',').map(n => String(n).padStart(4, '0')).join('-'), n: s.size }))
    .sort((a, b) => b.n - a.n).slice(0, 6);
}

let boardCache = null, boardCacheAt = 0;
function topBoard() {
  const now = Date.now();
  if (!boardCache || now - boardCacheAt > 30000) {
    boardCache = Object.entries(meta.board)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, n]) => ({ name, n, rank: rankOf((meta.profiles[name] || {}).jobsDone) }));
    boardCacheAt = now;
  }
  return boardCache;
}

function spawnPos(sx, sz) {
  const cx = sx * SECTOR + SECTOR / 2, cz = sz * SECTOR + SECTOR / 2;
  for (let i = 0; i < 60; i++) {
    const x = cx + (Math.random() * 48 - 24);
    const z = cz + (Math.random() * 48 - 24);
    const ix = Math.floor(x), iz = Math.floor(z);
    let clear = true;
    for (let dz = -2; dz <= 2 && clear; dz++)
      for (let dx = -2; dx <= 2 && clear; dx++)
        if (treeAt(ix + dx, iz + dz)) clear = false;
    if (clear) return { x, y: Math.max(effSurf(ix, iz), WATER_Y) + 2.5, z };
  }
  return { x: cx, y: WY - 4, z: cz }; // worst case: drop from the sky
}

// ---------------------------------------------------------------- torches & tombs (indexed by sector)
const torchIndex = new Map(); // skey -> array of torch objects (shared refs with meta)
const tombIndex = new Map();
const crateIndex = new Map();
const ladderIndex = new Map();
function idxAdd(map, item) {
  const k = skeyOf(item.x, item.z);
  let a = map.get(k);
  if (!a) map.set(k, a = []);
  a.push(item);
}
function idxRemove(map, item) {
  const k = skeyOf(item.x, item.z);
  const a = map.get(k);
  if (!a) return;
  const i = a.indexOf(item);
  if (i >= 0) a.splice(i, 1);
  if (!a.length) map.delete(k);
}
meta.torches.forEach(t => idxAdd(torchIndex, t));
meta.tombs.forEach(t => idxAdd(tombIndex, t));
meta.crates.forEach(c => idxAdd(crateIndex, c));
meta.ladders.forEach(l => idxAdd(ladderIndex, l));

function areaPayload(keys) {
  const torches = [], tombs = [], crates = [], ladders = [];
  for (const k of keys) {
    const ta = torchIndex.get(k); if (ta) torches.push(...ta);
    const ba = tombIndex.get(k); if (ba) tombs.push(...ba);
    const ca = crateIndex.get(k); if (ca) crates.push(...ca);
    const la = ladderIndex.get(k); if (la) ladders.push(...la);
  }
  return { torches, tombs, crates, ladders };
}

// a torch whose supporting block is destroyed is destroyed with it —
// no unattached lamps, ever
function reanchorTorches(bx, by, bz) {
  for (let i = meta.torches.length - 1; i >= 0; i--) {
    const t = meta.torches[i];
    const nx = t.nx || 0, ny = t.ny ?? 1, nz = t.nz || 0;
    if (t.x - nx !== bx || t.y - ny !== by || t.z - nz !== bz) continue;
    meta.torches.splice(i, 1);
    idxRemove(torchIndex, t);
    broadcastNear(t.x, t.z, { t: 'torchDel', x: t.x, y: t.y, z: t.z });
  }
}

// a ladder rung whose supporting wall block is destroyed falls with it
function reanchorLadders(bx, by, bz) {
  for (let i = meta.ladders.length - 1; i >= 0; i--) {
    const l = meta.ladders[i];
    if (l.x - l.nx !== bx || l.y !== by || l.z - l.nz !== bz) continue;
    meta.ladders.splice(i, 1);
    idxRemove(ladderIndex, l);
    broadcastNear(l.x, l.z, { t: 'ladderDel', x: l.x, y: l.y, z: l.z });
  }
}

// ---------------------------------------------------------------- anti-cheat ledger
// Server-side record of what each name's digging was actually worth. The client
// still reports money (selling is client-side), but it can never claim more
// than its blocks ever earned.
const VALUE_SRV = { 1: 1, 2: 1, 3: 2, 4: 8, 5: 20, 6: 60, 7: 300, 9: 3, 10: 1, 11: 1, 12: 10, 13: 30, 14: 120, 15: 500, 17: 2000, 21: 50 };
// "earth" = counts toward the 999-billion-block planetary goal. Trees (9/10)
// and placed furniture (tombstones 16, crates 20) are not earth; air, bedrock,
// the door and water are rejected before these checks ever run.
const isEarth = (v) => (v >= 1 && v <= 17 && v !== 9 && v !== 10 && v !== 16) || v === 21;
const BLOCK_NAMES = {
  1: 'sod', 2: 'dirt', 3: 'stone', 4: 'coal', 5: 'iron', 6: 'gold', 7: 'diamond',
  9: 'wood', 10: 'leaves', 11: 'sand', 12: 'copper', 13: 'silver', 14: 'amethyst', 15: 'fossil', 16: 'tombstone',
  17: 'artifact', 18: 'the door', 19: 'water', 20: 'storage crate', 21: 'company memo',
};

// ---------------------------------------------------------------- the paper trail
// 28 memos in 4 depth bands. The deeper you dig, the more the company admits.
// A memo slate always yields the same memo (deterministic by position).
const LORE = [
  // band 1 · topsoil (4–15m): onboarding
  { t: 'MEMO 0001 — WELCOME', b: 'Welcome to the Planetary Removal Service. Your shovel is your future. Do not ask where the earth goes; logistics is another department, and they do not answer their mail.' },
  { t: 'MEMO 0014 — RE: BREAKS', b: 'Breaks are permitted. The hole does not take breaks, and it is winning. This is not a threat, merely a standings update.' },
  { t: 'MEMO 0038 — INSURANCE', b: 'COMPANY INSURANCE covers one (1) death. Employees experiencing additional deaths are encouraged to space them out.' },
  { t: 'MEMO 0102 — RE: THE BIRDS', b: 'Several diggers report that the birdsong stops at ten meters. The birds are fine. They simply have nothing to say to you down there.' },
  { t: 'MEMO 0117 — SHOVEL POLICY', b: 'MK-I shovels are sticks. We know. The board voted. The stick "builds character and lowers onboarding costs."' },
  { t: 'MEMO 0166 — GRAVES', b: 'Tombstones are company property once interred. Robbing them is not theft; it is aggressive recycling, and it is encouraged.' },
  { t: 'MEMO 0203 — MOTIVATION', b: 'Reminder: the goal is 999,000,000,000 blocks. It is not a strange number. It was calculated precisely. Someone needed exactly that many.' },
  { t: 'MEMO 0007 — NOMENCLATURE', b: 'Officially, your employer is H.O.L.E. — Human Operated Land Extraction. Marketing shortened it. The full name tested poorly; respondents fixated on the word "extraction," and then on the word "human."' },
  // band 2 · subsoil (15–35m): logistics
  { t: 'MEMO 0311 — SHIPPING', b: 'To the employee asking where forty million tons of topsoil went last quarter: the trucks are empty when they leave. Please stop weighing the trucks.' },
  { t: 'MEMO 0350 — DRONE INCIDENT 44-C', b: 'Drone 44-C dug in a perfect spiral for nine days, then stopped and faced north for six hours. It has been reassigned. Do not face north with it.' },
  { t: 'MEMO 0397 — MANIFEST DISCREPANCY', b: 'Outbound: 2,114,000 blocks. Received at depot: 0 blocks. Depot reports this is "normal" and "has always been normal." Closing ticket.' },
  { t: 'MEMO 0402 — RE: ECHOES', b: 'If your digging echoes back before you strike, log the coordinates and move sites. Do not dig toward it. This has come up more than once.' },
  { t: 'MEMO 0455 — HR NOTICE', b: 'Survey Team 6 has been marked On Sabbatical. Their equipment was found neatly stacked. Their hole was found filled in. We do not fill holes.' },
  { t: 'MEMO 0481 — PAYROLL', b: 'Wages are funded by the sale of extracted material. "Sale to whom," asks the new intern. The intern is now in logistics. Nobody is in logistics.' },
  { t: 'MEMO 0524 — QUARTERLY', b: 'We remain ahead of schedule. "Schedule for what," asks the intern\'s replacement. Congratulations to logistics on their new hire.' },
  { t: 'MEMO 0512 — CATERING', b: 'The canteen at depth 20 has been closed since the incident. There was no incident. It has always been closed. Please stop describing the soup.' },
  // band 3 · the deep (35–55m): the Structure
  { t: 'MEMO 0688 — CLASSIFIED: AGGREGATE', b: 'The aggregate is being consumed faster than it is shipped. Engineering insists this is impossible. Engineering is reminded that impossibility is a surface concept.' },
  { t: 'MEMO 0714 — THE STRUCTURE (1/3)', b: 'Yes, it exists. No, you will not see it. It is not being built anywhere you could stand. Return to your assigned depth.' },
  { t: 'MEMO 0715 — THE STRUCTURE (2/3)', b: 'Latest projection: completion requires the full 999,000,000,000. Not one block fewer. It knows the count better than our ledgers do.' },
  { t: 'MEMO 0716 — THE STRUCTURE (3/3)', b: 'It has started to look like something. The architects have stopped attending meetings. The ones who did attend sat facing north.' },
  { t: 'MEMO 0790 — AMETHYST', b: 'Amethyst deposits ring like glass when struck. Purchasing asks that you not listen for the second ring. There should not be a second ring.' },
  { t: 'MEMO 0801 — DEEP SURVEY', b: 'Below forty meters, three teams report the same dream: an enormous room, almost finished, one wall missing. Wellness credits have been issued.' },
  { t: 'MEMO 0855 — RETENTION', b: 'Exit interviews for deep-shift diggers are suspended. Everyone gives the same answer, and the transcriptionist refuses to type it again.' },
  { t: 'MEMO 0777 — HEADCOUNT', b: 'Payroll lists forty thousand more diggers than HR has ever hired. Their timesheets are impeccable. Their shifts are at night. Approve the overtime.' },
  // band 4 · near bedrock (55m+): the doors
  { t: 'MEMO 0900 — THE DOORS', b: 'You have seen one by now. Sealed into bedrock. It predates the company. It predates the planet, which our lawyers note is not technically possible.' },
  { t: 'MEMO 0913 — DO NOT DIG', b: 'The signage says DO NOT DIG because DO NOT LET IT HEAR THE DIGGING fit poorly on the plate.' },
  { t: 'MEMO 0921 — KEYS', b: 'There is no key. It is not locked from our side. Please stop billing hours for lockpicking.' },
  { t: 'MEMO 0958 — FOUNDER\'S NOTE', b: 'The founder\'s original charter, water-damaged, reads only: "…found a buyer for the whole thing. Payment on delivery. Do not be here for delivery."' },
  { t: 'MEMO 0970 — INSTRUCTION', b: 'When the counter reaches zero, do not be holding a shovel. Do not be holding anything. Preferably, do not be.' },
  { t: 'MEMO 0984 — TO WHOEVER READS THIS', b: 'I hid these memos in the ground because the ground is the one place the company is certain to look. Keep digging. It is too late to stop, and stopping is worse.' },
  { t: 'MEMO 0999 — FINAL', b: 'When the last block is weighed, the Structure will be complete, and the door will open from its side. Thank you for your service. The company means this sincerely.' },
  { t: 'MEMO 0991 — RE: "HUMAN OPERATED"', b: 'The name Human Operated Land Extraction was a promise to the buyer, not a description. Machines could dig faster. The contract is specific: it must be dug by hand. It matters to them that it costs us something.' },
];
// ---------------------------------------------------------------- employment
// The JOBS board: randomly generated contracts, server-tracked, paid on
// completion. Completed contracts climb the rank ladder.
const RANKS = [
  ['INTERN', 0], ['DIGGER', 3], ['EXCAVATOR', 7], ['FOREMAN', 14],
  ['SITE MANAGER', 25], ['DIRECTOR OF DESCENT', 40], ['VP OF REMOVAL', 60],
];
function rankOf(done) {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if ((done || 0) >= RANKS[i][1]) r = i;
  return r;
}
function makeJob(seedA, seedB, tier) {
  const h = (salt) => hash3((seedA | 0) ^ (salt * 2654435761), tier * 131 + salt, (seedB | 0) ^ (salt * 40503));
  const R = (lo, hi, salt) => lo + Math.floor(h(salt) * (hi - lo + 1));
  const k = Math.floor(h(1) * 4);
  let j;
  if (tier === 1) {
    if (k === 0) { const need = R(25, 60, 2); j = { kind: 'dig', need, pay: 20 + need * 2 }; }
    else if (k === 1) { const need = R(8, 15, 3); j = { kind: 'depth', need, pay: need * 9 }; }
    else if (k === 2) { const need = R(3, 5, 4); j = { kind: 'torch', need, pay: 25 + need * 12 }; }
    else { const need = R(10, 20, 5); j = { kind: 'collect', mat: 4, need, pay: need * 5 }; }
  } else if (tier === 2) {
    const k2 = Math.floor(h(1) * 5);
    if (k2 === 0) { const need = R(150, 300, 2); j = { kind: 'dig', need, pay: need * 1.5 }; }
    else if (k2 === 1) { const need = R(20, 40, 3); j = { kind: 'depth', need, pay: need * 10 }; }
    else if (k2 === 2) { const need = R(30, 80, 4); j = { kind: 'blast', need, pay: 120 + need * 3 }; }
    else if (k2 === 3) { j = { kind: 'refer', need: 1, pay: R(250, 450, 7) }; }
    else { const mat = [12, 5][Math.floor(h(6) * 2)]; const need = R(15, 30, 5); j = { kind: 'collect', mat, need, pay: need * (mat === 5 ? 14 : 9) }; }
  } else {
    const k3 = Math.floor(h(1) * 5);
    if (k3 === 0) { const mat = [13, 6, 14][Math.floor(h(6) * 3)]; const need = R(8, 20, 5); j = { kind: 'collect', mat, need, pay: need * ({ 13: 40, 6: 70, 14: 130 }[mat]) }; }
    else if (k3 === 1) { const need = R(50, 64, 3); j = { kind: 'depth', need, pay: need * 18 }; }
    else if (k3 === 2) { j = { kind: 'grave', need: 1, pay: R(500, 900, 4) }; }
    else if (k3 === 3) { j = { kind: 'refer', need: 1, pay: R(350, 600, 7) }; }
    else { const need = R(800, 1600, 2) - (R(800, 1600, 2) % 100); j = { kind: 'sell', need, pay: Math.round(need * 0.45) }; }
  }
  j.pay = Math.round(j.pay);
  j.tier = tier;
  return j;
}
function jobDesc(j) {
  switch (j.kind) {
    case 'dig': return 'remove ' + j.need + ' blocks';
    case 'depth': return 'descend to ' + j.need + 'm';
    case 'torch': return 'plant ' + j.need + ' torches';
    case 'collect': return 'dig up ' + j.need + ' ' + (BLOCK_NAMES[j.mat] || 'blocks');
    case 'blast': return 'blast ' + j.need + ' blocks with dynamite';
    case 'grave': return "recover a colleague's remains";
    case 'refer': return 'recruit a new hire — a first-time digger must land at your site';
    case 'sell': return 'sell $' + j.need + ' of material in a single visit';
  }
  return '?';
}
function jobOffersFor(name, bx, bz) {
  const day = Math.floor(Date.now() / 86400000);
  const rank = rankOf((meta.profiles[name] || {}).jobsDone);
  const tiers = rank <= 1 ? [1, 1, 2] : rank <= 3 ? [1, 2, 3] : [2, 3, 3];
  return tiers.map((t, i) => {
    const j = makeJob((bx | 0) + day * 7919, (bz | 0) + i * 104729, t);
    return { id: i, ...j, desc: jobDesc(j) };
  });
}
function jobEvent(p, kind, data = {}) {
  const prof = meta.profiles[p.name];
  if (!prof || !prof.job) return;
  const j = prof.job;
  let inc = 0;
  if (j.kind === 'dig' && kind === 'dig') inc = 1;
  else if (j.kind === 'collect' && kind === 'dig' && data.v === j.mat) inc = 1;
  else if (j.kind === 'torch' && kind === 'torch') inc = 1;
  else if (j.kind === 'blast' && kind === 'blast') inc = data.n || 0;
  else if (j.kind === 'grave' && kind === 'grave') inc = 1;
  else if (j.kind === 'refer' && kind === 'refer') inc = 1;
  else if (j.kind === 'depth' && kind === 'dig' && (data.depth || 0) >= j.need) inc = j.need;
  else if (j.kind === 'sell' && kind === 'sell' && (data.value || 0) >= j.need) inc = j.need;
  if (!inc) return;
  j.n = Math.min(j.need, (j.n || 0) + inc);
  const send = (o) => { try { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); } catch (e) { /* offline */ } };
  if (j.n < j.need) { send({ t: 'jobProg', n: j.n, need: j.need }); return; }
  // contract complete: pay out, count it, maybe promote
  prof.money += j.pay;
  const before = rankOf(prof.jobsDone);
  prof.jobsDone = (prof.jobsDone || 0) + 1;
  prof.job = null;
  meta.stats.jobsCompleted = (meta.stats.jobsCompleted || 0) + 1;
  const after = rankOf(prof.jobsDone);
  send({ t: 'jobDone', pay: j.pay, money: prof.money, jobsDone: prof.jobsDone, rank: after });
  if (after > before) {
    const bonus = after * 500;
    prof.money += bonus;
    meta.stats.promotions = (meta.stats.promotions || 0) + 1;
    send({ t: 'promoted', rank: after, title: RANKS[after][0], bonus, money: prof.money });
    broadcastNear(p.x, p.z, { t: 'promoNear', name: p.name, title: RANKS[after][0] }, p.id);
  }
}

const LORE_BAND = 8; // memos per depth band
function memoAt(x, y, z) {
  const d = effSurf(x, z) - y;
  const band = d > 55 ? 3 : d > 35 ? 2 : d > 15 ? 1 : 0;
  return band * LORE_BAND + Math.floor(hash3(x ^ 555, y ^ 555, z ^ 555) * LORE_BAND);
}
const PACK_MAX_SRV = [0, 30, 80, 200, 500, 2000];
const CRATE_UNITS = 420;   // capacity of one storage crate
const CRATES_MAX = 20000;  // world-wide cap, oldest evicted
const PRICES = {
  shovel: [0, 0, 50, 300, 1500, 8000],
  pack: [0, 0, 40, 250, 1200, 6000],
  torch: 15, dyn: 250, insurance: 2500, crate: 420, ladder: 150, flare: 200,
};
const FLARE_COOLDOWN = 10000; // cost limits spam; the cooldown just keeps the sky legible
const LADDER_CAP = 200000;
function ensureProfile(name) {
  if (!meta.profiles[name])
    meta.profiles[name] = { money: 0, shovel: 1, pack: 1, jet: 0, lamp: 1, torches: 3, dyn: 0, crate: 0, ladders: 0, flare: 0, insured: false, deepest: 0, lore: [], job: null, jobsDone: 0 };
  return meta.profiles[name];
}
function svInvValue(p) {
  let v = 0;
  for (const k in p.svInv) v += p.svInv[k] * (VALUE_SRV[k] || 0);
  return v;
}
function credit(name, amount) {
  meta.earned[name] = (meta.earned[name] || 0) + amount;
}

// ---------------------------------------------------------------- global pace & milestones
let digsThisMinute = 0;
const digWindow = [];
function digRate() { // blocks per minute over the recent window
  const sum = digWindow.reduce((a, b) => a + b, 0) + digsThisMinute;
  return Math.round(sum / (digWindow.length + 0.5));
}
setInterval(() => {
  digWindow.push(digsThisMinute);
  digsThisMinute = 0;
  if (digWindow.length > 5) digWindow.shift();
}, 60000);

function afterEarthDug() {
  digsThisMinute++;
  if (meta.globalDug % 1000000 === 0)
    broadcastAll({ t: 'milestone', n: meta.globalDug });
}

// the only truly global chatter: a light heartbeat every 5s
setInterval(() => {
  broadcastAll({ t: 'global', global: meta.globalDug, online: players.size, rate: digRate() });
}, 5000);

// ---------------------------------------------------------------- death & dynamite
// Death is expensive: ALL equipment, money, and records reset — the whole
// fortune goes into the grave block for whoever digs it up.
function doDeath(p, cause) {
  // the grave's worth is computed HERE: wallet + cargo + $10 pity
  const prof = ensureProfile(p.name);
  const val = Math.max(10, Math.min((meta.earned[p.name] || 0) + 200,
    Math.floor(prof.money || 0) + (p.svInv ? svInvValue(p) : 0) + 10));
  meta.stats.deaths++;
  if (cause === 'fall') meta.stats.deathsFall++;
  else if (cause === 'dynamite') meta.stats.deathsDyn++;
  else meta.stats.deathsGaveUp++;
  meta.stats.graveValueBuried += val;
  // insurance keeps your shovel and pack through exactly one death
  const insured = !!prof.insured;
  meta.profiles[p.name] = {
    money: 0,
    shovel: insured ? prof.shovel : 1,
    pack: insured ? prof.pack : 1,
    jet: 0, lamp: 1, torches: 3, dyn: 0, crate: 0, ladders: 0, flare: 0, insured: false, deepest: 0,
    lore: prof.lore || [], // what you have READ, the company cannot bury again
    deaths: (prof.deaths || 0) + 1, // the personnel file remembers every burial
    job: null, // the active contract dies with you
    jobsDone: prof.jobsDone || 0, // rank survives — the ladder is forever
  };
  if (p.svInv) { p.svInv = {}; p.svInvN = 0; }
  const tx = Math.floor(p.x), tz = Math.floor(p.z);
  let ty = Math.floor(p.y), placed = false;
  for (let dy = 0; dy <= 2 && !placed; dy++) {
    if (inWorld(tx, ty + dy, tz) && getVoxel(tx, ty + dy, tz) === 0) {
      ty += dy; placed = true;
    }
  }
  if (placed) {
    setVoxel(tx, ty, tz, 16);
    broadcastNear(tx, tz, { t: 'set', x: tx, y: ty, z: tz, v: 16 });
    const tomb = { x: tx, y: ty, z: tz, name: p.name, val };
    meta.tombs.push(tomb);
    idxAdd(tombIndex, tomb);
    if (meta.tombs.length > TOMB_CAP) {
      const old = meta.tombs.shift();
      idxRemove(tombIndex, old);
      broadcastNear(old.x, old.z, { t: 'tombDel', x: old.x, y: old.y, z: old.z });
    }
    broadcastNear(tx, tz, { t: 'tombAdd', ...tomb });
  }
  const [sx, sz] = sectorOf(p.x, p.z);
  const pos = spawnPos(sx, sz);
  p.x = pos.x; p.y = pos.y; p.z = pos.z;
  p.lastDeath = Date.now();
  if (p.ws.readyState === 1)
    p.ws.send(JSON.stringify({ t: 'reborn', x: p.x, y: p.y, z: p.z, cause: cause || null, val, insured }));
  broadcastNear(p.x, p.z, { t: 'pos', id: p.id, x: p.x, y: p.y, z: p.z, ry: p.ry }, p.id);
}

// dynamite: removes a sphere of earth after a 3s fuse. Standing next to your
// own charge kills YOU (it cannot hurt anyone else).
const DYN_RADIUS = 3; // 3 up, 3 down, 3 left, 3 right — a tidy sphere
function detonate(owner, id, x, y, z) {
  if (owner.liveDyn) owner.liveDyn--;
  // if someone dug the floor out from under a burning charge, it kept falling
  while (y > 1 && getVoxel(x, y - 1, z) === 0) y--;
  const before = meta.globalDug;
  const R = Math.ceil(DYN_RADIUS), R2 = DYN_RADIUS * DYN_RADIUS;
  let count = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy + dz * dz > R2) continue;
        const bx = x + dx, by = y + dy, bz = z + dz;
        const v = getVoxel(bx, by, bz);
        if (v === 0 || v === 8 || v === 16 || v === 18 || v === 19 || v === 20 || v === 21) continue; // bedrock, graves, crates, memos, the door and water survive
        setVoxel(bx, by, bz, 0);
        if (isEarth(v)) { meta.globalDug++; digsThisMinute++; }
        bumpBlock(v);
        count++;
      }
  meta.stats.blocksBlasted += count;
  jobEvent(owner, 'blast', { n: count });
  if (players.has(owner.id)) meta.board[owner.name] = (meta.board[owner.name] || 0) + count;
  meta.digBySite[skeyOf(x, z)] = (meta.digBySite[skeyOf(x, z)] || 0) + count;
  // ladder rungs whose wall went up with the blast are destroyed
  for (let i = meta.ladders.length - 1; i >= 0; i--) {
    const l = meta.ladders[i];
    if (Math.abs(l.x - x) > R + 1 || Math.abs(l.y - y) > R + 1 || Math.abs(l.z - z) > R + 1) continue;
    if (getVoxel(l.x - l.nx, l.y, l.z - l.nz) === 0) {
      meta.ladders.splice(i, 1);
      idxRemove(ladderIndex, l);
      broadcastNear(l.x, l.z, { t: 'ladderDel', x: l.x, y: l.y, z: l.z });
    }
  }
  // torches whose support went up with the blast drop to the ground
  for (let i = meta.torches.length - 1; i >= 0; i--) {
    const t = meta.torches[i];
    if (Math.abs(t.x - x) > R + 1 || Math.abs(t.y - y) > R + 1 || Math.abs(t.z - z) > R + 1) continue;
    const sx2 = t.x - (t.nx || 0), sy2 = t.y - (t.ny ?? 1), sz2 = t.z - (t.nz || 0);
    if (getVoxel(sx2, sy2, sz2) === 0) {
      meta.torches.splice(i, 1);
      idxRemove(torchIndex, t);
      broadcastNear(t.x, t.z, { t: 'torchDel', x: t.x, y: t.y, z: t.z });
    }
  }
  if (Math.floor(meta.globalDug / 1000000) > Math.floor(before / 1000000))
    broadcastAll({ t: 'milestone', n: Math.floor(meta.globalDug / 1000000) * 1000000 });
  broadcastNear(x, z, { t: 'boom', id, x, y, z, r: DYN_RADIUS, global: meta.globalDug });
  // self-harm only: the blast kills its owner if they stood too close
  const p = players.get(owner.id);
  if (p) {
    const dx = p.x - (x + 0.5), dy = p.y + 1 - (y + 0.5), dz = p.z - (z + 0.5);
    if (dx * dx + dy * dy + dz * dz < 6 * 6) doDeath(p, 'dynamite');
  }
}

// ---------------------------------------------------------------- company drones
const bots = new Map(); // id -> { id, name, x, y, z, ry, hue, dir }

function spawnBot(near) {
  const ang = Math.random() * Math.PI * 2, r = 8 + Math.random() * 10;
  const x = Math.min(WX - 4, Math.max(4, Math.floor(near.x + Math.cos(ang) * r))) + 0.5;
  const z = Math.min(WZ - 4, Math.max(4, Math.floor(near.z + Math.sin(ang) * r))) + 0.5;
  const id = nextId++;
  const bot = {
    id, name: 'DRONE-' + String(id % 100).padStart(2, '0'),
    x, y: Math.max(effSurf(Math.floor(x), Math.floor(z)), WATER_Y) + 1, z,
    ry: 0, hue: 45, dir: [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)],
  };
  bots.set(id, bot);
  meta.stats.dronesDeployed++;
  broadcastNear(bot.x, bot.z, { t: 'pjoin', p: publicPlayer(bot) });
}

setInterval(() => { // fleet management: up to 2 AMBIENT drones per active site, 12 total
  for (const [id, b] of bots) {
    if (b.hired) continue; // hired rigs never clock out
    if (!bySector.has(skeyOf(b.x, b.z))) {
      bots.delete(id);
      broadcastNear(b.x, b.z, { t: 'pleave', id });
    }
  }
  let ambientTotal = 0;
  const counts = new Map();
  for (const b of bots.values()) {
    if (b.hired) continue;
    ambientTotal++;
    const k = skeyOf(b.x, b.z);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [k, set] of bySector) {
    const anchor = set.values().next().value;
    if (!anchor) continue;
    let need = 2 - (counts.get(k) || 0);
    while (need-- > 0 && ambientTotal < 12) { spawnBot(anchor); ambientTotal++; }
  }
}, 5000);

function botDig(b, x, y, z) {
  const v = getVoxel(x, y, z);
  if (!isEarth(v)) return false; // drones only remove earth (never graves, crates or trees)
  setVoxel(x, y, z, 0);
  meta.globalDug++;
  afterEarthDug();
  bumpBlock(v);
  meta.digBySite[skeyOf(x, z)] = (meta.digBySite[skeyOf(x, z)] || 0) + 1;
  if (b.hired) {
    meta.stats.digsByHired = (meta.stats.digsByHired || 0) + 1;
    meta.board[b.owner] = (meta.board[b.owner] || 0) + 1; // your rig digs on your record
  } else {
    meta.stats.digsByDrones++;
  }
  broadcastNear(x, z, { t: 'dug', x, y, z, was: v, by: b.id, global: meta.globalDug });
  reanchorTorches(x, y, z); reanchorLadders(x, y, z);
  return true;
}

function droneAct(b) {
  const r = Math.random();
  if (r < 0.15) b.dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
  const fx = Math.floor(b.x), fy = Math.floor(b.y), fz = Math.floor(b.z);
  if (r < 0.3) {
    if (fy - 1 > 2 && botDig(b, fx, fy - 1, fz)) b.y -= 1; // dig down, drop in
  } else {
    const tx = fx + b.dir[0], tz = fz + b.dir[1];
    if (tx < 2 || tz < 2 || tx >= WX - 2 || tz >= WZ - 2) { b.dir = [-b.dir[0], -b.dir[1]]; return; }
    const feet = getVoxel(tx, fy, tz), head = getVoxel(tx, fy + 1, tz);
    if (feet !== 0) {
      if (!botDig(b, tx, fy, tz)) b.dir = [-b.dir[0], -b.dir[1]]; // bedrock/tree: turn around
    } else if (isEarth(head)) {
      botDig(b, tx, fy + 1, tz);
    } else {
      b.x = tx + 0.5; b.z = tz + 0.5;
      let drops = 0;
      while (drops++ < 3 && Math.floor(b.y) > 3 &&
             getVoxel(Math.floor(b.x), Math.floor(b.y) - 1, Math.floor(b.z)) === 0) b.y -= 1;
    }
  }
  b.ry = Math.atan2(b.dir[0], b.dir[1]);
  broadcastNear(b.x, b.z, { t: 'pos', id: b.id, x: b.x, y: b.y, z: b.z, ry: b.ry });
}

setInterval(() => { // ambient drones dig aimlessly, slowly (~1 block every 3s each)
  for (const b of bots.values()) {
    if (b.hired || Math.random() > 0.25) continue;
    droneAct(b);
  }
}, 700);

// hired rigs work, they don't wander: dig on almost every action
function rigAct(b) {
  if (Math.random() < 0.12) b.dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
  const fx = Math.floor(b.x), fy = Math.floor(b.y), fz = Math.floor(b.z);
  const tx = fx + b.dir[0], tz = fz + b.dir[1];
  const inB = tx >= 2 && tz >= 2 && tx < WX - 2 && tz < WZ - 2;
  const feet = inB ? getVoxel(tx, fy, tz) : 8;
  const head = inB ? getVoxel(tx, fy + 1, tz) : 8;
  const diggable = isEarth;
  if (diggable(feet)) botDig(b, tx, fy, tz);
  else if (diggable(head)) botDig(b, tx, fy + 1, tz);
  else if (feet === 0 && head === 0 && Math.random() < 0.5) {
    b.x = tx + 0.5; b.z = tz + 0.5;
    let drops = 0;
    while (drops++ < 3 && Math.floor(b.y) > 3 &&
           getVoxel(Math.floor(b.x), Math.floor(b.y) - 1, Math.floor(b.z)) === 0) b.y -= 1;
  } else if (fy - 1 > 2 && botDig(b, fx, fy - 1, fz)) {
    b.y -= 1; // no way forward: dig the hole deeper
  } else {
    b.dir = [-b.dir[0], -b.dir[1]];
  }
  b.ry = Math.atan2(b.dir[0], b.dir[1]);
  broadcastNear(b.x, b.z, { t: 'pos', id: b.id, x: b.x, y: b.y, z: b.z, ry: b.ry });
}

// one action every 8.64s ≈ 10,000 blocks/day, forever, owner online or not
setInterval(() => {
  const now = Date.now();
  for (const b of bots.values()) {
    if (!b.hired) continue;
    if (now - (b.lastAct || 0) < 8640) continue;
    b.lastAct = now;
    rigAct(b);
  }
}, 2000);

function spawnHired(owner, near) {
  const ang = Math.random() * Math.PI * 2, r = 4 + Math.random() * 6;
  const x = Math.min(WX - 4, Math.max(4, Math.floor(near.x + Math.cos(ang) * r))) + 0.5;
  const z = Math.min(WZ - 4, Math.max(4, Math.floor(near.z + Math.sin(ang) * r))) + 0.5;
  const id = nextId++;
  const bot = {
    id, name: (owner.slice(0, 10).toUpperCase()) + "'S RIG",
    x, y: Math.min(WY - 2, Math.max(2, Math.floor(near.y) + 1)), z,
    ry: 0, hue: 205, dir: [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)],
    hired: true, owner, lastAct: 0,
  };
  bots.set(id, bot);
  broadcastNear(bot.x, bot.z, { t: 'pjoin', p: publicPlayer(bot) });
  return bot;
}

// resurrect the payroll from disk
if (!Array.isArray(meta.hired)) meta.hired = [];
for (const h of meta.hired) {
  const id = nextId++;
  bots.set(id, {
    id, name: (String(h.owner).slice(0, 10).toUpperCase()) + "'S RIG",
    x: h.x, y: h.y, z: h.z, ry: 0, hue: 205,
    dir: [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)],
    hired: true, owner: h.owner, lastAct: 0,
  });
}

// ---------------------------------------------------------------- /stats report
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function fmt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
function dur(sec) {
  sec = Math.round(sec || 0);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}

function renderStats() {
  const s = meta.stats;
  const liveSeconds = [...players.values()].reduce((a, p) => a + (Date.now() - (p.joinedAt || Date.now())) / 1000, 0);
  const rate = digRate();
  const remaining = meta.totalDiggable - meta.globalDug;
  const etaYears = rate > 0 ? remaining / rate / (60 * 24 * 365.25) : null;
  const totalEarned = Object.values(meta.earned).reduce((a, b) => a + b, 0);

  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const section = (title, rows) =>
    `<div class="panel"><h2>${title}</h2><table>${rows}</table></div>`;

  const matRows = Object.entries(s.byBlock)
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => row(esc(BLOCK_NAMES[v] || 'block ' + v), fmt(n) + ' <span class="dim">($' + fmt(n * (VALUE_SRV[v] || 0)) + ' gross)</span>'))
    .join('') || row('nothing yet', 'get digging');

  const geoRows = Object.entries(s.countries)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => row(esc(c), fmt(n) + ' digger(s)'))
    .join('') || row('no origin data', 'the company respects a mystery');

  const boardRows = topBoard()
    .map((r, i) => row((i + 1) + '. ' + esc(r.name), fmt(r.n) + ' blocks'))
    .join('') || row('vacant', '—');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>HOLE — Company Report</title>
<link rel="icon" type="image/png" href="/icon-192.png">
<meta property="og:title" content="HOLE — Planetary Removal Service">
<meta property="og:description" content="A pointless massively multiplayer hole. Dig forever. Together we will remove all 999,000,000,000 blocks of earth.">
<meta property="og:type" content="website">
<meta property="og:image" content="https://holeplanet.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://holeplanet.com/og.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet">
<style>
  :root { --soil:#14100a; --panel:#1e150c; --paper:#f2e6c8; --amber:#ffb347; --line:#4a3720; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--soil); color:var(--paper); font-family:'Silkscreen',ui-monospace,monospace;
         padding:24px 16px 60px; max-width:900px; margin:0 auto; }
  h1 { color:var(--amber); font-size:20px; letter-spacing:3px; text-align:center; }
  .sub { text-align:center; font-size:9px; opacity:.6; margin:6px 0 22px; letter-spacing:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
  .panel { background:var(--panel); border:2px solid var(--line); box-shadow:4px 4px 0 rgba(0,0,0,.5); padding:12px 14px; }
  h2 { color:var(--amber); font-size:10px; letter-spacing:2px; border-bottom:2px dashed var(--line); padding-bottom:6px; margin-bottom:8px; }
  table { width:100%; font-size:9px; border-collapse:collapse; }
  td { padding:3px 0; vertical-align:top; }
  td:last-child { text-align:right; color:var(--amber); }
  .dim { color:var(--paper); opacity:.5; }
  .big { text-align:center; padding:14px 0 4px; }
  .big b { color:var(--amber); font-size:15px; display:block; }
  .big span { font-size:8px; opacity:.6; }
  a { color:var(--amber); }
  .foot { text-align:center; font-size:8px; opacity:.5; margin-top:22px; line-height:2; }
</style></head><body>
<a href="/" style="position:fixed;top:12px;left:12px;z-index:10;background:var(--panel);border:2px solid var(--line);color:var(--amber);text-decoration:none;font-size:10px;letter-spacing:2px;padding:8px 14px;border-radius:6px">← HOME</a>
<h1>PLANETARY REMOVAL SERVICE</h1>
<div class="sub">COMPANY REPORT · FORM 27-B · GENERATED ${esc(new Date().toUTCString())} · REFRESHES ITSELF</div>
<div class="panel" style="margin-bottom:14px"><div class="big">
  <b>${fmt(meta.globalDug)} / ${fmt(meta.totalDiggable)}</b>
  <span>BLOCKS REMOVED · ${(100 - meta.globalDug / meta.totalDiggable * 100).toFixed(9)}% OF THE EARTH REMAINS ·
  ${rate > 0 ? 'CURRENT PACE ' + fmt(rate) + '/MIN · GONE IN ' + (etaYears > 1e6 ? (etaYears / 1e6).toFixed(1) + ' MILLION YEARS' : fmt(etaYears) + ' YEARS') : 'NO DIGGING DETECTED. DISAPPOINTING.'}</span>
</div></div>
<div class="grid">
${section('WORKFORCE', [
  row('employees (all time)', fmt(Object.keys(meta.board).length)),
  row('shifts clocked', fmt(s.joins)),
  row('contracts completed', fmt(s.jobsCompleted || 0) + ' <span class="dim">(' + fmt(s.promotions || 0) + ' promotions)</span>'),
  row('on site right now', fmt(players.size)),
  row('peak concurrency', fmt(s.peak)),
  row('hours worked', dur(s.seconds + liveSeconds)),
  row('drones deployed', fmt(s.dronesDeployed)),
  row('rigs on payroll', fmt([...bots.values()].filter(b => b.hired).length) + ' <span class="dim">(' + fmt(s.rigsHired) + ' hired ever)</span>'),
  row('sites disturbed', fmt(Object.keys(s.sites).length) + ' <span class="dim">of 55,696</span>'),
].join(''))}
${section('CASUALTIES', [
  row('deaths in service', fmt(s.deaths)),
  row('· resignations (K)', fmt(s.deathsGaveUp)),
  row('· gravity incidents', fmt(s.deathsFall)),
  row('· dynamite incidents', fmt(s.deathsDyn)),
  row('graves standing', fmt(meta.tombs.length)),
  row('graves robbed', fmt(s.gravesRobbed) + ' <span class="dim">($' + fmt(s.graveValueRobbed) + ')</span>'),
  row('wealth interred', '$' + fmt(s.graveValueBuried)),
].join(''))}
${section('LABOR OUTPUT', [
  row('blocks by employees', fmt(s.digsByPlayers)),
  row('blocks by drones', fmt(s.digsByDrones)),
  row('blocks by hired rigs', fmt(s.digsByHired)),
  row('blocks by dynamite', fmt(s.blocksBlasted)),
  row('trees felled', fmt(s.treesFelled)),
  row('tombstones exhumed', fmt(s.tombsDug)),
  row('deepest excavation', fmt(s.deepestEver) + 'm'),
  row('gross value extracted', '$' + fmt(totalEarned)),
].join(''))}
${section('EQUIPMENT ISSUED', [
  row('shovel upgrades', fmt(s.shovelsIssued)),
  row('backpack upgrades', fmt(s.packsIssued)),
  row('torches acquired', fmt(s.torchesAcquired)),
  row('torches placed', fmt(s.torchesPlaced)),
  row('torches burning now', fmt(meta.torches.length)),
  row('dynamite armed', fmt(s.dynPlaced)),
  row('ladder rungs sold', fmt(s.laddersSold) + ' <span class="dim">(' + fmt(meta.ladders.length) + ' bolted to walls)</span>'),
  row('flare shells sold', fmt(s.flaresSold || 0) + ' <span class="dim">(' + fmt(s.flaresFired || 0) + ' signals fired)</span>'),
  row('storage crates sold', fmt(s.cratesSold)),
  row('crates in the deep', fmt(meta.crates.length) + ' <span class="dim">(' + fmt(s.cratesSmashed) + ' smashed)</span>'),
  row('blocks entombed in crates', fmt(s.blocksCrated) + ' <span class="dim">(paid $0 — as agreed)</span>'),
].join(''))}
${section('SECURITY DIVISION', [
  row('dig-rate violations blocked', fmt(s.rlDigBlocked)),
  row('teleport attempts blocked', fmt(s.tpBlocked)),
  row('fraudulent balances corrected', fmt(s.moneyClamped)),
].join(''))}
${section('MATERIALS LEDGER', matRows)}
${section('WORKFORCE ORIGIN', geoRows)}
${section('TOP REMOVERS (ALL TIME)', boardRows)}
${section('FRONT OFFICE (TRAFFIC)', [
  row('landing page visits', fmt(s.views.landing || 0)),
  row('game loads (/play)', fmt(s.views.play || 0)),
  row('damage map views', fmt(s.views.map || 0)),
  row('report views (this page)', fmt(s.views.stats || 0)),
  row('personnel file pulls', fmt(s.views.report || 0)),
  row('visit → shift conversion', (s.views.play ? ((s.joins / s.views.play) * 100).toFixed(1) + '%' : '—')),
].join(''))}
${section('SYSTEM', [
  row('server uptime', dur((Date.now() - BOOT_TIME) / 1000)),
  row('server boots', fmt(s.boots)),
  row('memos unearthed', fmt(s.memosFound) + ' <span class="dim">(' + Object.keys(s.loreSeen || {}).length + ' of ' + LORE.length + ' in circulation)</span>'),
  row('chunks resident in memory', fmt(chunks.size)),
  row('world clock', ((Date.now() / 1000 % DAY_LEN) / DAY_LEN < 0.7 ? 'daylight' : 'night')),
].join(''))}
</div>
<div class="foot">the planet must go. all of it. — <a href="/">home</a> · <a href="/play">dig</a> · <a href="/map">damage map</a></div>
</body></html>`;
}

// ---------------------------------------------------------------- /release-notes
// Curated, player-facing. Newest first. Add an entry when a round ships.
const RELEASES = [
  ['2026-08-23', 'THE JOBS BOARD', ['A JOBS signpost now spawns near your X — randomly generated contracts, paid on completion.', 'Promotions: complete contracts to climb from INTERN to VP OF REMOVAL. Ranks show on name tags and personnel files.', 'Recruiting contracts: get paid when a first-time digger lands at your site.', 'Right-click works like E. Closing any menu drops you straight back into the game.', 'The employee handbook now enforces naming standards at the door.', 'The diggers have a Telegram. This page exists.']],
  ['2026-08-23', 'SIGNALS & STOCKPILES', ['Flare shells: $200, fires a purple voxel star visible across the whole neighborhood.', 'A compass, next to the clock.', 'The hotbar only shows items you own.', 'Store bundles (×5) for rungs, dynamite and flares; rapid purchases always land.']],
  ['2026-08-23', 'PERSONNEL FILES', ['H.O.L.E. — the full name is buried somewhere below 4 meters.', '/report: pull the Form 27-B/E of any employee, living or interred.', 'The damage map now bleeds red where the planet is wounded, and both pages have a HOME button.']],
  ['2026-08-23', 'HOLEPLANET.COM', ['The planet has a domain.', 'Share links unfurl properly. There is a favicon. Civilization.']],
  ['2026-08-23', 'THE PAPER TRAIL', ['32 company memos are buried in the deep. The deeper you dig, the more the company admits.', 'Grave bounties now land in your actual wallet (sorry).', 'Ladder rungs: $150, bolt to walls, SPACE climbs. No fall damage while holding on.']],
  ['2026-08-22', 'OPENING DAY', ['The planet went live: 999,000,000,000 blocks, one shared persistent world.', 'Swamps with islands, deserts with palms, forests. Dig under the water.', 'Storage crates, dynamite, tombstones, drones, hired rigs, insurance, THE DOOR.', 'Shovel progression: your MK-I is a stick. The board voted.']],
];
function renderReleases() {
  const entries = RELEASES.map(([date, title, items]) => `
<div class="panel" style="margin-bottom:14px"><h2>${esc(title)} <span class="dim" style="float:right">${esc(date)}</span></h2>
<ul style="font-size:9px;line-height:2;list-style:none">${items.map(i => '<li>· ' + esc(i) + '</li>').join('')}</ul></div>`).join('');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>H.O.L.E. — Release Notes</title>
<link rel="icon" type="image/png" href="/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet">
<style>
  :root { --soil:#14100a; --panel:#1e150c; --paper:#f2e6c8; --amber:#ffb347; --line:#4a3720; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--soil); color:var(--paper); font-family:'Silkscreen',ui-monospace,monospace;
         padding:24px 16px 60px; max-width:760px; margin:0 auto; }
  h1 { color:var(--amber); font-size:20px; letter-spacing:3px; text-align:center; }
  .sub { text-align:center; font-size:9px; opacity:.6; margin:6px 0 22px; letter-spacing:2px; }
  .panel { background:var(--panel); border:2px solid var(--line); box-shadow:4px 4px 0 rgba(0,0,0,.5); padding:12px 14px; }
  h2 { color:var(--amber); font-size:10px; letter-spacing:2px; border-bottom:2px dashed var(--line); padding-bottom:6px; margin-bottom:8px; }
  .dim { color:var(--paper); opacity:.5; font-size:8px; }
  .foot { text-align:center; font-size:8px; opacity:.5; margin-top:26px; }
  a { color:var(--amber); }
</style></head><body>
<a href="/" style="position:fixed;top:12px;left:12px;z-index:10;background:var(--panel);border:2px solid var(--line);color:var(--amber);text-decoration:none;font-size:10px;letter-spacing:2px;padding:8px 14px;border-radius:6px">← HOME</a>
<h1>SITE BULLETIN</h1>
<div class="sub">CHANGES TO YOUR WORKPLACE · POSTED BY FACILITIES · COMPLAINTS TO THE HOLE</div>
${entries}
<div class="foot">the planet must go. all of it. — <a href="/">home</a> · <a href="/play">dig</a> · <a href="/stats">company report</a></div>
</body></html>`;
}

// ---------------------------------------------------------------- /report: the personnel file
const SHOVEL_TITLES = ['', 'STICK MK-I', 'WOOD SHOVEL MK-II', 'STEEL SHOVEL MK-III', 'BRONZE SHOVEL MK-IV', 'DIAMONDEDGE MK-V'];
function renderReport(nameRaw) {
  const name = String(nameRaw || '').slice(0, 40);
  const prof = name ? meta.profiles[name] : null;
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const section = (title, rows) => `<div class="panel"><h2>${title}</h2><table>${rows}</table></div>`;
  const sc = (x, z) => String(Math.floor(x / SECTOR)).padStart(4, '0') + '-' + String(Math.floor(z / SECTOR)).padStart(4, '0');
  const lookup = `<div class="panel" style="max-width:420px;margin:0 auto"><h2>RECORDS DESK</h2>
    <div style="font-size:9px;opacity:.7;margin-bottom:10px">Form 27-B/E — request the personnel file of any employee, living or interred.</div>
    <input id="q" placeholder="employee name" style="width:100%;background:#0d0a06;border:2px solid var(--line);color:var(--paper);font-family:inherit;font-size:11px;padding:9px;margin-bottom:8px"
      onkeydown="if(event.key==='Enter')document.getElementById('go').click()">
    <button id="go" onclick="location='/report?name='+encodeURIComponent(document.getElementById('q').value.trim())"
      style="width:100%;background:var(--amber);border:0;color:#241708;font-family:inherit;font-size:11px;letter-spacing:2px;padding:10px;cursor:pointer">PULL THE FILE</button></div>`;
  let body;
  if (!name) {
    body = lookup;
  } else if (!prof) {
    body = `<div class="sub" style="color:#ff6a5e">NO EMPLOYEE ON RECORD UNDER "${esc(name)}" — the company has never heard of them, officially</div>` + lookup;
  } else {
    const graves = meta.tombs.filter(t => t.name === name);
    const rigs = [...bots.values()].filter(b => b.hired && b.owner === name).length;
    const online = [...players.values()].some(p => p.name === name);
    body = `
<div class="sub">EMPLOYEE: <span style="color:var(--amber)">${esc(name)}</span> · STATUS: ${online ? '<span style="color:#7fe7a0">ON SITE</span>' : 'OFF DUTY'}</div>
<div class="grid">
${section('EXTRACTION RECORD', [
  row('blocks removed (all time)', fmt(meta.board[name] || 0)),
  row('lifetime gross earnings', '$' + fmt(meta.earned[name] || 0)),
  row('current balance', '$' + fmt(prof.money || 0)),
  row('deepest descent', fmt(prof.deepest || 0) + 'm'),
  row('burials', fmt(prof.deaths || 0)),
].join(''))}
${section('EQUIPMENT ON RECORD', [
  row('shovel', SHOVEL_TITLES[prof.shovel] || 'STICK MK-I'),
  row('backpack', 'MK-' + ['0', 'I', 'II', 'III', 'IV', 'V'][prof.pack || 1]),
  row('torches / dynamite / rungs', fmt(prof.torches || 0) + ' / ' + fmt(prof.dyn || 0) + ' / ' + fmt(prof.ladders || 0)),
  row('storage crate carried', prof.crate ? 'yes' : 'no'),
  row('company insurance', prof.insured ? 'ACTIVE' : 'none'),
  row('rigs on payroll', fmt(rigs)),
].join(''))}
${section('EMPLOYMENT', [
  row('rank', RANKS[rankOf(prof.jobsDone)][0]),
  row('contracts completed', fmt(prof.jobsDone || 0)),
  row('current contract', prof.job ? esc(jobDesc(prof.job)) + ' <span class="dim">(' + (prof.job.n || 0) + '/' + prof.job.need + ')</span>' : 'between engagements'),
  row('memos recovered', fmt((prof.lore || []).length) + ' <span class="dim">of ' + LORE.length + '</span>'),
  row('clearance level', ['NONE', 'CLERICAL', 'CLERICAL', 'LOGISTICS', 'LOGISTICS', 'STRUCTURAL', 'STRUCTURAL', 'THE DOOR'][Math.min(7, Math.floor((prof.lore || []).length / 4))]),
].join(''))}
${section('GRAVES CURRENTLY STANDING', graves.length
  ? graves.map(g => row('site ' + sc(g.x, g.z), '$' + fmt(g.val) + ' <span class="dim">unclaimed</span>')).join('')
  : row('none', 'all remains accounted for'))}
</div>
<div style="text-align:center;margin-top:18px"><a href="/report" style="color:var(--amber);font-size:9px;letter-spacing:2px">PULL ANOTHER FILE</a></div>`;
  }
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>H.O.L.E. — Personnel File</title>
<link rel="icon" type="image/png" href="/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet">
<style>
  :root { --soil:#14100a; --panel:#1e150c; --paper:#f2e6c8; --amber:#ffb347; --line:#4a3720; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--soil); color:var(--paper); font-family:'Silkscreen',ui-monospace,monospace;
         padding:24px 16px 60px; max-width:900px; margin:0 auto; }
  h1 { color:var(--amber); font-size:20px; letter-spacing:3px; text-align:center; }
  .sub { text-align:center; font-size:9px; opacity:.75; margin:6px 0 22px; letter-spacing:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
  .panel { background:var(--panel); border:2px solid var(--line); box-shadow:4px 4px 0 rgba(0,0,0,.5); padding:12px 14px; }
  h2 { color:var(--amber); font-size:10px; letter-spacing:2px; border-bottom:2px dashed var(--line); padding-bottom:6px; margin-bottom:8px; }
  table { width:100%; font-size:9px; border-collapse:collapse; }
  td { padding:3px 0; vertical-align:top; }
  td:last-child { text-align:right; color:var(--amber); }
  .dim { color:var(--paper); opacity:.5; }
  .foot { text-align:center; font-size:8px; opacity:.5; margin-top:26px; }
</style></head><body>
<a href="/" style="position:fixed;top:12px;left:12px;z-index:10;background:var(--panel);border:2px solid var(--line);color:var(--amber);text-decoration:none;font-size:10px;letter-spacing:2px;padding:8px 14px;border-radius:6px">← HOME</a>
<h1>PERSONNEL FILE</h1>
<div class="sub">FORM 27-B/E · HUMAN RESOURCES DIVISION · RECORDS ARE PERMANENT</div>
${body}
<div class="foot">the planet must go. all of it. — <a href="/" style="color:var(--amber)">home</a> · <a href="/play" style="color:var(--amber)">dig</a> · <a href="/stats" style="color:var(--amber)">company report</a></div>
</body></html>`;
}

// ---------------------------------------------------------------- /map: the scarred earth
// base terrain per site, banded from the height noise (computed once, static)
let mapBaseCache = null;
function mapBase() {
  // the map IS the worldgen: one biome sample per site center
  if (mapBaseCache) return mapBaseCache;
  let s = '';
  for (let sz = 0; sz < SECTORS_Z; sz++)
    for (let sx = 0; sx < SECTORS_X; sx++)
      s += biomeAt(sx * SECTOR + 250, sz * SECTOR + 250);
  mapBaseCache = s;
  return s;
}
function renderMap() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HOLE — Damage Map</title>
<link rel="icon" type="image/png" href="/icon-192.png">
<meta property="og:title" content="HOLE — Planetary Removal Service">
<meta property="og:description" content="A pointless massively multiplayer hole. Dig forever. Together we will remove all 999,000,000,000 blocks of earth.">
<meta property="og:type" content="website">
<meta property="og:image" content="https://holeplanet.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://holeplanet.com/og.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet">
<style>
  :root { --soil:#14100a; --panel:#1e150c; --paper:#f2e6c8; --amber:#ffb347; --line:#4a3720; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--soil); color:var(--paper); font-family:'Silkscreen',ui-monospace,monospace;
         display:flex; flex-direction:column; align-items:center; padding:22px 12px 50px; }
  h1 { color:var(--amber); font-size:16px; letter-spacing:3px; }
  .sub { font-size:8px; opacity:.6; margin:6px 0 16px; letter-spacing:2px; text-align:center; line-height:2; }
  #wrap { position:relative; border:2px solid var(--line); box-shadow:5px 5px 0 rgba(0,0,0,.5);
          background:var(--panel); line-height:0; }
  canvas { image-rendering:pixelated; cursor:crosshair; }
  #tip { position:absolute; pointer-events:none; background:var(--panel); border:2px solid var(--amber);
         padding:6px 8px; font-size:8px; display:none; z-index:2; white-space:nowrap; line-height:1.8; }
  .legend { font-size:8px; opacity:.7; margin-top:12px; line-height:2.2; text-align:center; }
  .sw { display:inline-block; width:9px; height:9px; vertical-align:middle; margin:0 3px; }
  a { color:var(--amber); }
  .foot { font-size:8px; opacity:.5; margin-top:16px; }
</style></head><body>
<a href="/" style="position:fixed;top:12px;left:12px;z-index:10;background:var(--panel);border:2px solid var(--line);color:var(--amber);text-decoration:none;font-size:10px;letter-spacing:2px;padding:8px 14px;border-radius:6px">← HOME</a>
<h1>DAMAGE MAP</h1>
<div class="sub">EVERY SITE WE HAVE WOUNDED · 236×236 SITES OF 500×500 BLOCKS ·
CLICK A SCAR TO COPY ITS WORLD CODE</div>
<div id="wrap"><canvas id="c" width="236" height="236" style="width:708px;max-width:92vw"></canvas><div id="tip"></div></div>
<div class="legend">
  <span class="sw" style="background:#2e6f8e"></span> swamp
  <span class="sw" style="background:#d8a95c"></span> desert
  <span class="sw" style="background:#44702a"></span> grassland
  <span class="sw" style="background:#55923b"></span> parkland
  <span class="sw" style="background:#2b4c1c"></span> forest
  <br>
  <span class="sw" style="background:#1e6fff"></span> scratched
  <span class="sw" style="background:#8b2be2"></span> excavated
  <span class="sw" style="background:#ff1717"></span> devastated
  <span class="sw" style="background:#00ffe1"></span> diggers on site now
</div>
<div class="foot"><a href="/">home</a> · <a href="/play">dig</a> · <a href="/stats">company report</a></div>
<script>
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const tip = document.getElementById('tip'), wrap = document.getElementById('wrap');
let sites = {}, active = new Set(), base = '';
const BASECOL = [
  ['#2e6f8e', '#266180', '#337b9d'],  // swamp waters
  ['#d8a95c', '#cc9d50', '#e0b468'],  // desert
  ['#c9b06b', '#bfa45f', '#d2bb77'],  // dunes
  ['#7a8a3a', '#6f7f33', '#849545'],  // dry grassland
  ['#44702a', '#3d6525', '#4b7a2f'],  // grassland
  ['#55923b', '#4c8534', '#5e9f42'],  // parkland
  ['#2b4c1c', '#264418', '#305420'],  // forest
];
const TERRAIN = ['swamp', 'desert', 'dunes', 'dry grassland', 'grassland', 'parkland', 'forest'];
function heat(n) {
  // damage reads as VIOLENCE: blue → purple → magenta → red, high contrast on the terrain
  if (n <= 0) return null;
  if (n < 50) return '#1e6fff';
  if (n < 1000) return '#8b2be2';
  if (n < 10000) return '#e91e63';
  return '#ff1717';
}
function draw() {
  ctx.fillStyle = '#241708';
  ctx.fillRect(0, 0, 236, 236);
  if (base) {
    for (let sz = 0; sz < 236; sz++)
      for (let sx = 0; sx < 236; sx++) {
        const b = base.charCodeAt(sz * 236 + sx) - 48;
        const shades = BASECOL[b] || BASECOL[4];
        ctx.fillStyle = shades[(sx * 31 + sz * 17) % 3];
        ctx.fillRect(sx, sz, 1, 1);
      }
  }
  for (const k in sites) {
    const [sx, sz] = k.split(',').map(Number);
    const c = heat(sites[k]);
    if (c) { ctx.fillStyle = c; ctx.fillRect(sx, sz, 1, 1); }
  }
  ctx.fillStyle = '#00ffe1';
  for (const k of active) {
    const [sx, sz] = k.split(',').map(Number);
    ctx.fillRect(sx, sz, 1, 1);
  }
}
async function load() {
  try {
    const d = await (await fetch('/mapdata')).json();
    sites = d.sites || {};
    active = new Set(d.active || []);
    draw();
  } catch (e) {}
}
fetch('/mapbase').then(r => r.json()).then(d => { base = d.base || ''; draw(); }).catch(() => {});
load(); setInterval(load, 10000);
const code = (sx, sz) => String(sx).padStart(4, '0') + '-' + String(sz).padStart(4, '0');
cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  const sx = Math.floor((e.clientX - r.left) / r.width * 236);
  const sz = Math.floor((e.clientY - r.top) / r.height * 236);
  const n = sites[sx + ',' + sz] || 0;
  tip.style.display = 'block';
  tip.style.left = (e.clientX - r.left + 14) + 'px';
  tip.style.top = (e.clientY - r.top + 8) + 'px';
  const b = base ? base.charCodeAt(sz * 236 + sx) - 48 : -1;
  tip.innerHTML = 'SITE ' + code(sx, sz)
    + (TERRAIN[b] ? ' · ' + TERRAIN[b] : '')
    + '<br>' + n.toLocaleString() + ' blocks removed'
    + (active.has(sx + ',' + sz) ? '<br>ACTIVE NOW' : '');
});
cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
cv.addEventListener('click', (e) => {
  const r = cv.getBoundingClientRect();
  const sx = Math.floor((e.clientX - r.left) / r.width * 236);
  const sz = Math.floor((e.clientY - r.top) / r.height * 236);
  navigator.clipboard && navigator.clipboard.writeText(code(sx, sz));
  tip.innerHTML = 'SITE ' + code(sx, sz) + '<br>CODE COPIED — use it on the join screen';
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------- landing page
function renderLanding() {
  const taglines = [
    'THE PLANET MUST GO. ALL OF IT.',
    '999 BILLION BLOCKS. ZERO REASONS.',
    'DIG. SELL. UPGRADE. DIG.',
    'A HOLE IS FOREVER.',
    'YOUR SHOVEL AWAITS PROCESSING.',
    'TOGETHER WE CAN REMOVE EVERYTHING.',
  ];
  const tag = taglines[Math.floor(Date.now() / 60000) % taglines.length];
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HOLE</title>
<link rel="icon" type="image/png" href="/icon-192.png">
<meta property="og:title" content="HOLE — Planetary Removal Service">
<meta property="og:description" content="A pointless massively multiplayer hole. Dig forever. Together we will remove all 999,000,000,000 blocks of earth.">
<meta property="og:type" content="website">
<meta property="og:image" content="https://holeplanet.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://holeplanet.com/og.png">
<link rel="manifest" href="/manifest.json">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --soil:#14100a; --panel:#1e150c; --paper:#f2e6c8; --amber:#ffb347; --line:#4a3720; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--soil); color:var(--paper); font-family:'Silkscreen',ui-monospace,monospace;
         min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
         text-align:center; padding:28px 16px; gap:0;
         background-image:radial-gradient(ellipse at 50% 120%, #241708 0%, var(--soil) 60%); }
  h1 { color:var(--amber); font-size:clamp(44px,12vw,92px); letter-spacing:.35em; text-indent:.35em;
       text-shadow:6px 6px 0 rgba(0,0,0,.55); }
  .tag { font-size:10px; letter-spacing:3px; opacity:.75; margin:10px 0 30px; }
  .live { background:var(--panel); border:2px solid var(--line); box-shadow:5px 5px 0 rgba(0,0,0,.5);
          padding:16px 22px; margin-bottom:30px; max-width:640px; }
  .live b { color:var(--amber); font-size:clamp(15px,3.4vw,24px); display:block; letter-spacing:1px; }
  .live span { font-size:9px; opacity:.65; display:block; margin-top:6px; line-height:1.9; }
  a.play { display:block; width:min(420px, 88vw); margin:0 auto; padding:20px 26px;
           font-size:16px; letter-spacing:3px; text-decoration:none;
           background:var(--amber); color:#221507; box-shadow:6px 6px 0 rgba(0,0,0,.55); }
  a.play:active { transform:translate(2px,2px); box-shadow:3px 3px 0 rgba(0,0,0,.55); }
  .navrow { display:flex; gap:10px; flex-wrap:wrap; justify-content:center;
            max-width:560px; margin:18px auto 0; }
  a.stats { display:inline-block; padding:10px 14px; font-size:9px; letter-spacing:2px;
            text-decoration:none; background:var(--panel); color:var(--paper);
            border:2px solid var(--line); box-shadow:3px 3px 0 rgba(0,0,0,.5); opacity:.9; }
  a.stats:hover { color:var(--amber); opacity:1; }
  a.stats:active { transform:translate(1px,1px); box-shadow:2px 2px 0 rgba(0,0,0,.5); }
  .fine { font-size:8px; opacity:.4; margin-top:34px; line-height:2; max-width:520px; }
  .shovel { font-size:30px; animation:dig 2.2s ease-in-out infinite; display:inline-block; margin-bottom:8px; }
  @keyframes dig { 0%,100% { transform:rotate(-8deg) translateY(0); } 50% { transform:rotate(14deg) translateY(6px); } }
</style></head><body>
<div class="shovel">⛏</div>
<h1>H.O.L.E.</h1>
<div class="tag">PLANETARY REMOVAL SERVICE · ${esc(tag)}</div>
<div class="live">
  <b id="count">${fmt(meta.globalDug)}</b>
  <span>OF ${fmt(meta.totalDiggable)} BLOCKS REMOVED ·
  <span style="display:inline" id="pct">${(100 - meta.globalDug / meta.totalDiggable * 100).toFixed(9)}</span>% OF THE EARTH REMAINS<br>
  <span style="display:inline" id="online">${fmt(players.size)}</span> DIGGER(S) ON SHIFT ·
  <span style="display:inline" id="pace">${digRate() > 0 ? fmt(digRate()) + ' BLOCKS/MIN' : 'THE SHOVELS ARE SILENT'}</span></span>
</div>
<div>
  <a class="play" href="/play">⛏ START DIGGING</a>
  <div class="navrow">
    <a class="stats" href="/stats">📊 COMPANY REPORT</a>
    <a class="stats" href="/map">🗺 DAMAGE MAP</a>
    <a class="stats" href="/report">🗂 PERSONNEL FILES</a>
    <a class="stats" href="/release-notes">📌 SITE BULLETIN</a>
    <a class="stats" href="https://t.me/+GZVX2ylyEZgzYTZk" target="_blank" rel="noopener">💬 DIGGERS&#39; TELEGRAM</a>
  </div>
</div>
<div class="fine">runs in your browser · phone or desktop · progress is permanent ·
deaths are also permanent · the company is not liable for gravity, dynamite, or despair ·
form 27-B available upon request</div>
<script>
setInterval(async () => {
  try {
    const h = await (await fetch('/health')).json();
    document.getElementById('count').textContent = h.global.toLocaleString('en-US');
    document.getElementById('pct').textContent = (100 - h.global / h.total * 100).toFixed(9);
    document.getElementById('online').textContent = h.online.toLocaleString('en-US');
    document.getElementById('pace').textContent = h.rate > 0 ? h.rate.toLocaleString('en-US') + ' BLOCKS/MIN' : 'THE SHOVELS ARE SILENT';
  } catch (e) {}
}, 4000);
</script>
</body></html>`;
}

// ---------------------------------------------------------------- http
const INDEX = path.join(__dirname, 'public', 'index.html');
const STATIC = {
  '/manifest.json': 'application/manifest+json',
  '/og.png': 'image/png',
  '/favicon.ico': 'image/png',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
};
function noteView(page) { meta.stats.views[page] = (meta.stats.views[page] || 0) + 1; }
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    noteView('landing');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderLanding());
  } else if (req.url === '/play' || req.url.startsWith('/play?') || req.url.startsWith('/index')) {
    noteView('play');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
  } else if (STATIC[req.url]) {
    res.writeHead(200, { 'Content-Type': STATIC[req.url] });
    fs.createReadStream(path.join(__dirname, 'public', req.url)).pipe(res);
  } else if (req.url === '/map') {
    noteView('map');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMap());
  } else if (req.url === '/mapbase') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    res.end(JSON.stringify({ w: SECTORS_X, base: mapBase() }));
  } else if (req.url === '/mapdata') {
    const active = [...bySector.keys()];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ w: SECTORS_X, sites: meta.digBySite, active }));
  } else if (req.url === '/release-notes') {
    noteView('releases');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReleases());
  } else if (req.url === '/report' || req.url.startsWith('/report?')) {
    noteView('report');
    const q = new URL(req.url, 'http://x').searchParams.get('name');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReport(q));
  } else if (req.url === '/stats') {
    noteView('stats');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStats());
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, global: meta.globalDug, total: meta.totalDiggable,
      online: players.size, rate: digRate(), sites: activeSites(),
    }));
  } else {
    res.writeHead(404); res.end('there is only the hole');
  }
});

// ---------------------------------------------------------------- ws
const wss = new WebSocketServer({ server, perMessageDeflate: { threshold: 1024 } });
// ws re-emits http server errors and would crash with a raw stack before our
// friendly EADDRINUSE message below gets a chance — swallow them here
wss.on('error', () => {});

// a player crossed a sector boundary: exchange rosters + area objects
function handleCrossing(p, oldKey, newKey) {
  meta.stats.sites[newKey] = 1;
  sectorRemove(p);
  p.skey = newKey;
  let s = bySector.get(newKey);
  if (!s) bySector.set(newKey, s = new Set());
  s.add(p);

  const oldNine = new Set(nineKeys(oldKey));
  const newNine = nineKeys(newKey);
  const entered = newNine.filter(k => !oldNine.has(k));
  const newSet = new Set(newNine);
  const left = [...oldNine].filter(k => !newSet.has(k));

  const myJoin = JSON.stringify({ t: 'pjoin', p: publicPlayer(p) });
  for (const k of entered) {
    const set = bySector.get(k);
    if (set) for (const q of set) {
      if (q.id === p.id) continue;
      if (q.ws.readyState === 1) q.ws.send(myJoin);
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'pjoin', p: publicPlayer(q) }));
    }
    for (const b of bots.values())
      if (skeyOf(b.x, b.z) === k && p.ws.readyState === 1)
        p.ws.send(JSON.stringify({ t: 'pjoin', p: publicPlayer(b) }));
  }
  const myLeave = JSON.stringify({ t: 'pleave', id: p.id });
  for (const k of left) {
    const set = bySector.get(k);
    if (set) for (const q of set) {
      if (q.id === p.id) continue;
      if (q.ws.readyState === 1) q.ws.send(myLeave);
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'pleave', id: q.id }));
    }
    for (const b of bots.values())
      if (skeyOf(b.x, b.z) === k && p.ws.readyState === 1)
        p.ws.send(JSON.stringify({ t: 'pleave', id: b.id }));
  }
  if (entered.length && p.ws.readyState === 1) {
    const area = areaPayload(entered);
    p.ws.send(JSON.stringify({ t: 'area', sectors: entered, torches: area.torches, tombs: area.tombs, crates: area.crates, ladders: area.ladders }));
  }
}

wss.on('connection', (ws, req) => {
  let me = null;
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || '';

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join' && !me) {
      const name = String(m.name || 'digger').slice(0, 16).replace(/[^\w\- ]/g, '') || 'digger';
      if (isBannedName(name)) {
        ws.send(JSON.stringify({ t: 'joinFail', reason: 'that name violates the employee handbook — HR has standards, somehow. pick another.' }));
        return;
      }
      // identity: first token to use a name claims it, forever
      const token = String(m.token || '');
      const th = token ? crypto.createHash('sha1').update(token).digest('hex') : '';
      if (meta.auth[name]) {
        if (!th || meta.auth[name] !== th) {
          ws.send(JSON.stringify({ t: 'joinFail', reason: '"' + name + '" is claimed by another digger — pick a different name (or enter its claim code)' }));
          return;
        }
      } else if (th) {
        meta.auth[name] = th;
      }
      // land at the requested site, else the busiest one, else the home site
      let sx = SECTORS_X >> 1, sz = SECTORS_Z >> 1;
      if (Array.isArray(m.sector) && m.sector.length === 2) {
        const a = m.sector[0] | 0, b = m.sector[1] | 0;
        if (a >= 0 && a < SECTORS_X && b >= 0 && b < SECTORS_Z) { sx = a; sz = b; }
      } else {
        const top = activeSites()[0];
        if (top) [sx, sz] = top.code.split('-').map(Number);
      }
      const pos = spawnPos(sx, sz);
      me = {
        id: nextId++, name, x: pos.x, y: pos.y, z: pos.z, ry: 0,
        hue: Math.floor(Math.random() * 360), ws,
        digTokens: 10, digRefill: Date.now(), lastMove: 0, lastDeath: 0,
        svInv: {}, svInvN: 0, // server-side pack: the client is not trusted with cargo
      };
      players.set(me.id, me);
      sectorAdd(me);
      me.joinedAt = Date.now();
      meta.stats.joins++;
      meta.stats.peak = Math.max(meta.stats.peak, players.size);
      meta.stats.sites[me.skey] = 1;
      noteGeo(clientIp);
      const isNewHire = !(name in meta.board) && !meta.profiles[name]; // never dug, never profiled
      if (!(name in meta.board)) meta.board[name] = 0;
      const prof = ensureProfile(name);
      const nine = nineKeys(me.skey);
      const roster = [];
      for (const k of nine) {
        const s = bySector.get(k);
        if (s) for (const q of s) if (q.id !== me.id) roster.push(publicPlayer(q));
      }
      for (const b of bots.values())
        if (nine.includes(skeyOf(b.x, b.z))) roster.push(publicPlayer(b));
      const area = areaPayload(nine);
      ws.send(JSON.stringify({
        t: 'init', id: me.id, wx: WX, wy: WY, wz: WZ, chunk: CHUNK, sectorSize: SECTOR,
        dayLen: DAY_LEN, dayT: (Date.now() / 1000) % DAY_LEN,
        total: meta.totalDiggable, global: meta.globalDug, rate: digRate(),
        x: me.x, y: me.y, z: me.z, site: siteCode(sx, sz),
        players: roster,
        board: topBoard(), profile: prof, online: players.size,
        torches: area.torches, tombs: area.tombs, crates: area.crates, ladders: area.ladders, sites: activeSites(),
        loreLog: (prof.lore || []).filter(i => LORE[i]).map(i => ({ id: i, title: LORE[i].t, text: LORE[i].b })),
        loreTotal: LORE.length,
      }));
      broadcastNear(me.x, me.z, { t: 'pjoin', p: publicPlayer(me) }, me.id);
      // a genuinely new hire landing here completes any nearby "recruit" contracts
      if (isNewHire) {
        for (const k of nine) {
          const s = bySector.get(k);
          if (s) for (const q of s) if (q.id !== me.id) jobEvent(q, 'refer');
        }
      }
      return;
    }
    if (!me) return;

    if (m.t === 'chunks' && Array.isArray(m.list)) {
      for (const trip of m.list.slice(0, 128)) {
        const cx = trip[0] | 0, cy = trip[1] | 0, cz = trip[2] | 0;
        if (cx < 0 || cy < 0 || cz < 0 || cx >= CX || cy >= CY || cz >= CZ) continue;
        const c = getChunk(cx, cy, cz);
        ws.send(JSON.stringify({ t: 'chunk', cx, cy, cz, b64: Buffer.from(c.data).toString('base64') }));
      }
      return;
    }

    if (m.t === 'move') {
      const now = Date.now();
      if (now - me.lastMove < 35) return; // drop floods
      me.lastMove = now;
      const x = +m.x, y = +m.y, z = +m.z, ry = +m.ry || 0;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      // anti-teleport: nobody moves 30+ blocks between updates
      if (Math.abs(x - me.x) > 30 || Math.abs(y - me.y) > 30 || Math.abs(z - me.z) > 30) {
        meta.stats.tpBlocked++;
        return;
      }
      me.x = Math.min(WX, Math.max(0, x));
      me.y = Math.min(WY + 20, Math.max(0, y));
      me.z = Math.min(WZ, Math.max(0, z));
      me.ry = ry;
      const nk = skeyOf(me.x, me.z);
      if (nk !== me.skey) handleCrossing(me, me.skey, nk);
      broadcastNear(me.x, me.z, { t: 'pos', id: me.id, x: me.x, y: me.y, z: me.z, ry: me.ry }, me.id);
      return;
    }

    if (m.t === 'dig') {
      // token bucket: sustained 8 digs/sec, small burst
      const now = Date.now();
      me.digTokens = Math.min(10, me.digTokens + (now - me.digRefill) * 0.008);
      me.digRefill = now;
      if (me.digTokens < 1) { meta.stats.rlDigBlocked++; return; }
      me.digTokens -= 1;
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      const dx = x + 0.5 - me.x, dy = y + 0.5 - me.y, dz = z + 0.5 - me.z;
      if (dx * dx + dy * dy + dz * dz > 8 * 8) return; // generous reach check
      const v = getVoxel(x, y, z);
      if (v === 0 || v === 8 || v === 18 || v === 19) return; // no digging doors or water
      if (v === 20) {
        // smashing a storage crate: everything inside is lost forever (as advertised)
        const a = crateIndex.get(skeyOf(x, z)) || [];
        const crate = a.find(c => c.x === x && c.y === y && c.z === z);
        if (crate) {
          meta.crates.splice(meta.crates.indexOf(crate), 1);
          idxRemove(crateIndex, crate);
          meta.stats.cratesSmashed++;
          broadcastNear(x, z, { t: 'crateDel', x, y, z });
        }
        setVoxel(x, y, z, 0);
        broadcastNear(x, z, { t: 'dug', x, y, z, was: v, by: me.id, global: meta.globalDug });
        reanchorTorches(x, y, z); reanchorLadders(x, y, z);
        return;
      }
      if (v === 16) {
        // digging a tombstone collects its bounty
        const a = tombIndex.get(skeyOf(x, z)) || [];
        const tomb = a.find(t => t.x === x && t.y === y && t.z === z);
        if (tomb) {
          if (tomb.name === me.name && now - (me.lastDeath || 0) < 15000) return; // not your own fresh grave
          meta.tombs.splice(meta.tombs.indexOf(tomb), 1);
          idxRemove(tombIndex, tomb);
          credit(me.name, tomb.val);
          // the bounty goes straight into the SERVER wallet — previously it only
          // hit the client display and evaporated on the next money sync
          const prof = ensureProfile(me.name);
          prof.money += tomb.val;
          meta.stats.gravesRobbed++;
          meta.stats.graveValueRobbed += tomb.val;
          broadcastNear(x, z, { t: 'tombDel', x, y, z });
          ws.send(JSON.stringify({ t: 'tombGot', val: tomb.val, name: tomb.name, money: prof.money }));
          jobEvent(me, 'grave');
        }
        setVoxel(x, y, z, 0);
        meta.stats.tombsDug++;
        broadcastNear(x, z, { t: 'dug', x, y, z, was: v, by: me.id, global: meta.globalDug });
        reanchorTorches(x, y, z); reanchorLadders(x, y, z);
        return;
      }
      setVoxel(x, y, z, 0);
      if (isEarth(v)) { meta.globalDug++; afterEarthDug(); } // trees don't count toward removing the earth
      meta.stats.digsByPlayers++;
      bumpBlock(v);
      meta.digBySite[me.skey] = (meta.digBySite[me.skey] || 0) + 1;
      if (v === 9 || v === 10) meta.stats.treesFelled++;
      credit(me.name, VALUE_SRV[v] || 0);
      // cargo lives on the server; a full pack digs for the planet, not the wallet
      if (me.svInvN < PACK_MAX_SRV[ensureProfile(me.name).pack]) {
        me.svInv[v] = (me.svInv[v] || 0) + 1;
        me.svInvN++;
      }
      meta.board[me.name] = (meta.board[me.name] || 0) + 1;
      jobEvent(me, 'dig', { v, depth: effSurf(x, z) - y });
      if (v === 21) {
        // a memo slate: the text is determined by where it lay buried
        const prof = ensureProfile(me.name);
        const id = memoAt(x, y, z);
        prof.lore = prof.lore || [];
        const isNew = !prof.lore.includes(id);
        if (isNew) prof.lore.push(id);
        meta.stats.memosFound++;
        meta.stats.loreSeen[id] = (meta.stats.loreSeen[id] || 0) + 1;
        ws.send(JSON.stringify({
          t: 'lore', id, title: LORE[id].t, text: LORE[id].b,
          fresh: isNew, have: prof.lore.length, total: LORE.length,
        }));
      }
      broadcastNear(x, z, { t: 'dug', x, y, z, was: v, by: me.id, global: meta.globalDug });
      reanchorTorches(x, y, z); reanchorLadders(x, y, z);
      return;
    }

    if (m.t === 'torch') {
      // torches are server inventory: placing one spends it HERE, so the count
      // the store reports can never drift from what you actually hold
      const prof = ensureProfile(me.name);
      if (!(prof.torches > 0)) return;
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      if (!inWorld(x, y, z) || getVoxel(x, y, z) !== 0) return;
      const dx = x + 0.5 - me.x, dy = y + 0.5 - me.y, dz = z + 0.5 - me.z;
      if (dx * dx + dy * dy + dz * dz > 8 * 8) return;
      const a = torchIndex.get(skeyOf(x, z)) || [];
      if (a.some(t => t.x === x && t.y === y && t.z === z)) return;
      prof.torches--;
      let nx = m.nx | 0, ny = m.ny | 0, nz = m.nz | 0;
      if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) !== 1 || ny === -1) { nx = 0; ny = 1; nz = 0; }
      const torch = { x, y, z, nx, ny, nz };
      meta.stats.torchesPlaced++;
      meta.torches.push(torch);
      idxAdd(torchIndex, torch);
      if (meta.torches.length > TORCH_CAP) {
        const old = meta.torches.shift();
        idxRemove(torchIndex, old);
        broadcastNear(old.x, old.z, { t: 'torchDel', x: old.x, y: old.y, z: old.z });
      }
      broadcastNear(x, z, { t: 'torchAdd', ...torch });
      jobEvent(me, 'torch');
      return;
    }

    if (m.t === 'die') {
      doDeath(me, m.cause === 'fall' ? 'fall' : 'gave up');
      return;
    }

    if (m.t === 'ladder') {
      const prof = ensureProfile(me.name);
      if (!(prof.ladders > 0)) return;
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      if (!inWorld(x, y, z) || getVoxel(x, y, z) !== 0) return;
      const dx = x + 0.5 - me.x, dy = y + 0.5 - me.y, dz = z + 0.5 - me.z;
      if (dx * dx + dy * dy + dz * dz > 8 * 8) return;
      const nx = m.nx | 0, nz = m.nz | 0;
      if (Math.abs(nx) + Math.abs(nz) !== 1) return; // rungs bolt to WALLS only
      const wall = getVoxel(x - nx, y, z - nz);
      if (wall === 0 || wall === 19) return; // must anchor into something solid
      const a = ladderIndex.get(skeyOf(x, z)) || [];
      if (a.some(l => l.x === x && l.y === y && l.z === z)) return;
      prof.ladders--;
      const rung = { x, y, z, nx, nz };
      meta.ladders.push(rung);
      idxAdd(ladderIndex, rung);
      meta.stats.laddersPlaced++;
      if (meta.ladders.length > LADDER_CAP) {
        const old = meta.ladders.shift();
        idxRemove(ladderIndex, old);
        broadcastNear(old.x, old.z, { t: 'ladderDel', x: old.x, y: old.y, z: old.z });
      }
      broadcastNear(x, z, { t: 'ladderAdd', ...rung }, me.id);
      return;
    }

    if (m.t === 'jobs') {
      const offers = jobOffersFor(me.name, m.bx, m.bz);
      const prof = ensureProfile(me.name);
      ws.send(JSON.stringify({
        t: 'jobOffers', offers,
        job: prof.job ? { ...prof.job, desc: jobDesc(prof.job) } : null,
        jobsDone: prof.jobsDone || 0, rank: rankOf(prof.jobsDone),
      }));
      return;
    }
    if (m.t === 'jobTake') {
      const prof = ensureProfile(me.name);
      if (prof.job) {
        ws.send(JSON.stringify({ t: 'jobFail', reason: 'finish (or abandon) your current contract first' }));
        return;
      }
      const offers = jobOffersFor(me.name, m.bx, m.bz);
      const pick = offers[(m.id | 0)] || null;
      if (!pick) return;
      prof.job = { kind: pick.kind, mat: pick.mat, need: pick.need, pay: pick.pay, tier: pick.tier, n: 0 };
      ws.send(JSON.stringify({ t: 'jobTaken', job: { ...prof.job, desc: jobDesc(prof.job) } }));
      return;
    }
    if (m.t === 'jobDrop') {
      const prof = ensureProfile(me.name);
      prof.job = null;
      ws.send(JSON.stringify({ t: 'jobDropped' }));
      return;
    }

    if (m.t === 'flare') {
      const prof = ensureProfile(me.name);
      if (!(prof.flare > 0)) return; // shells are consumable — no shell, no signal
      const nowF = Date.now();
      const wait = FLARE_COOLDOWN - (nowF - (me.lastFlare || 0));
      if (wait > 0) {
        ws.send(JSON.stringify({ t: 'flareFail', wait: Math.ceil(wait / 1000) }));
        return;
      }
      me.lastFlare = nowF;
      prof.flare--;
      meta.stats.flaresFired = (meta.stats.flaresFired || 0) + 1;
      ws.send(JSON.stringify({ t: 'flareCnt', flare: prof.flare }));
      broadcastNear(me.x, me.z, { t: 'flare', id: nextId++, x: me.x, y: me.y, z: me.z, name: me.name });
      return;
    }

    if (m.t === 'cratePlace') {
      const prof = ensureProfile(me.name);
      if (!(prof.crate > 0)) return;
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      if (!inWorld(x, y, z) || getVoxel(x, y, z) !== 0) return;
      const dx = x + 0.5 - me.x, dy = y + 0.5 - me.y, dz = z + 0.5 - me.z;
      if (dx * dx + dy * dy + dz * dz > 8 * 8) return;
      const below = getVoxel(x, y - 1, z);
      if (below === 0 || below === 19) {
        ws.send(JSON.stringify({ t: 'crateFail', reason: 'a crate needs solid ground under it' }));
        return;
      }
      if (y > effSurf(x, z)) {
        ws.send(JSON.stringify({ t: 'crateFail', reason: 'underground storage goes UNDER the ground — dig first' }));
        return;
      }
      prof.crate--;
      const crate = { x, y, z, name: me.name, used: 0 };
      meta.crates.push(crate);
      idxAdd(crateIndex, crate);
      meta.stats.cratesPlaced++;
      if (meta.crates.length > CRATES_MAX) {
        const old = meta.crates.shift();
        idxRemove(crateIndex, old);
        if (getVoxel(old.x, old.y, old.z) === 20) setVoxel(old.x, old.y, old.z, 0);
        broadcastNear(old.x, old.z, { t: 'crateDel', x: old.x, y: old.y, z: old.z });
        broadcastNear(old.x, old.z, { t: 'set', x: old.x, y: old.y, z: old.z, v: 0 });
      }
      setVoxel(x, y, z, 20);
      broadcastNear(x, z, { t: 'set', x, y, z, v: 20 });
      broadcastNear(x, z, { t: 'crateAdd', x, y, z, name: crate.name, used: 0 });
      return;
    }

    if (m.t === 'dump') {
      // one-way: cargo goes in, nothing comes out, nobody gets paid
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      const dx = x + 0.5 - me.x, dy = y + 0.5 - me.y, dz = z + 0.5 - me.z;
      if (dx * dx + dy * dy + dz * dz > 8 * 8) return;
      const a = crateIndex.get(skeyOf(x, z)) || [];
      const crate = a.find(c => c.x === x && c.y === y && c.z === z);
      if (!crate) return;
      if (me.svInvN <= 0) {
        ws.send(JSON.stringify({ t: 'dumpFail', reason: 'your pack is empty' }));
        return;
      }
      const space = CRATE_UNITS - crate.used;
      if (space <= 0) {
        ws.send(JSON.stringify({ t: 'dumpFail', reason: 'crate is full — ' + CRATE_UNITS + '/' + CRATE_UNITS }));
        return;
      }
      const n = Math.min(me.svInvN, space);
      let left = n;
      for (const k in me.svInv) {
        const take = Math.min(me.svInv[k], left);
        me.svInv[k] -= take;
        if (!me.svInv[k]) delete me.svInv[k];
        left -= take;
        if (!left) break;
      }
      me.svInvN -= n;
      crate.used += n;
      meta.stats.blocksCrated += n;
      ws.send(JSON.stringify({ t: 'dumped', x, y, z, n, used: crate.used, cap: CRATE_UNITS, packN: me.svInvN }));
      broadcastNear(x, z, { t: 'crateUpd', x, y, z, used: crate.used }, me.id);
      return;
    }

    if (m.t === 'dynamite') {
      const prof = ensureProfile(me.name);
      if (!(prof.dyn > 0)) return; // you can only arm what you actually bought
      const x = m.x | 0, y = m.y | 0, z = m.z | 0;
      if (!inWorld(x, y, z) || getVoxel(x, y, z) !== 0) return;
      const ddx = x + 0.5 - me.x, ddy = y + 0.5 - me.y, ddz = z + 0.5 - me.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > 8 * 8) return;
      me.liveDyn = me.liveDyn || 0;
      if (me.liveDyn >= 3) return; // no carpet bombing
      me.liveDyn++;
      prof.dyn--;
      meta.stats.dynPlaced++;
      // dynamite falls: it comes to rest on the first solid block below
      let fy = y;
      while (fy > 1 && getVoxel(x, fy - 1, z) === 0) fy--;
      const dynId = nextId++;
      broadcastNear(x, z, { t: 'dynAdd', id: dynId, x, y, z, fy });
      setTimeout(() => detonate(me, dynId, x, fy, z), 3000);
      return;
    }

    if (m.t === 'sell') {
      const prof = ensureProfile(me.name);
      const value = svInvValue(me);
      me.svInv = {}; me.svInvN = 0;
      if (value > 0) prof.money += value;
      ws.send(JSON.stringify({ t: 'sold', value, money: prof.money }));
      if (value > 0) jobEvent(me, 'sell', { value });
      return;
    }

    if (m.t === 'buy') {
      // every buy message is one deliberate click (buttons blur on click, so a held
      // Enter key can't machine-gun purchases) — rapid clicking is legitimate stocking up
      const prof = ensureProfile(me.name);
      const qty = Math.max(1, Math.min(25, (m.qty | 0) || 1)); // consumables only
      const item = String(m.item || '');
      let cost = 0, ok = true, reason = '';
      if (item === 'shovel' || item === 'pack') {
        const next = (prof[item] || 1) + 1;
        if (next > 5) { ok = false; reason = 'already at MK-V'; }
        else cost = PRICES[item][next];
      } else if (item === 'torch') cost = PRICES.torch;
      else if (item === 'dyn') cost = PRICES.dyn * qty;
      else if (item === 'ladder') cost = PRICES.ladder * qty;
      else if (item === 'flare') cost = PRICES.flare * qty;
      else if (item === 'crate') {
        cost = PRICES.crate;
        if ((prof.crate || 0) >= 1) { ok = false; reason = 'one crate per digger — place the one you have'; }
      } else if (item === 'insurance') {
        cost = PRICES.insurance;
        if (prof.insured) { ok = false; reason = 'already insured'; }
      } else { ok = false; reason = 'no such item'; }
      if (ok && prof.money < cost) { ok = false; reason = 'insufficient funds'; }
      if (!ok) {
        ws.send(JSON.stringify({ t: 'buyFail', reason }));
        return;
      }
      prof.money -= cost;
      if (item === 'shovel') { prof.shovel++; meta.stats.shovelsIssued++; }
      else if (item === 'pack') { prof.pack++; meta.stats.packsIssued++; }
      else if (item === 'torch') { prof.torches += 5; meta.stats.torchesAcquired += 5; }
      else if (item === 'dyn') { prof.dyn += qty; }
      else if (item === 'ladder') { prof.ladders = (prof.ladders || 0) + qty; meta.stats.laddersSold += qty; }
      else if (item === 'flare') { prof.flare = (prof.flare || 0) + qty; meta.stats.flaresSold = (meta.stats.flaresSold || 0) + qty; }
      else if (item === 'crate') { prof.crate = 1; meta.stats.cratesSold++; }
      else if (item === 'insurance') prof.insured = true;
      ws.send(JSON.stringify({
        t: 'bought', item, money: prof.money,
        shovel: prof.shovel, pack: prof.pack, torches: prof.torches,
        dyn: prof.dyn, crate: prof.crate || 0, ladders: prof.ladders || 0,
        flare: prof.flare || 0, insured: !!prof.insured,
      }));
      return;
    }

    if (m.t === 'hire') {
      // server-authoritative purchase: the company handles the money directly
      const prof = meta.profiles[me.name];
      const money = prof ? (prof.money || 0) : 0;
      const owned = [...bots.values()].filter(b => b.hired && b.owner === me.name).length;
      if (owned >= 3) {
        ws.send(JSON.stringify({ t: 'hireFail', reason: 'payroll cap: 3 rigs per employee' }));
        return;
      }
      if (money < 10000) {
        ws.send(JSON.stringify({ t: 'hireFail', reason: 'a rig costs $10,000 — keep digging' }));
        return;
      }
      prof.money = money - 10000;
      spawnHired(me.name, me);
      meta.stats.rigsHired = (meta.stats.rigsHired || 0) + 1;
      ws.send(JSON.stringify({ t: 'hired', money: prof.money }));
      return;
    }

    if (m.t === 'save' && m.profile && typeof m.profile === 'object') {
      // the ledger is fully server-owned now; the client may only report depth records
      const p = m.profile;
      const prof = ensureProfile(me.name);
      if ((+p.money || 0) > prof.money + 1) meta.stats.moneyClamped++; // still counting the liars
      const deep = Math.min(96, Math.max(0, +p.deepest || 0));
      if (deep > (prof.deepest || 0)) prof.deepest = deep;
      if (deep > meta.stats.deepestEver) meta.stats.deepestEver = deep;
      return;
    }

    if (m.t === 'board') {
      ws.send(JSON.stringify({
        t: 'board', top: topBoard(), online: players.size,
        global: meta.globalDug, rate: digRate(),
      }));
      return;
    }
  });

  ws.on('close', () => {
    if (me) {
      meta.stats.seconds += (Date.now() - (me.joinedAt || Date.now())) / 1000;
      sectorRemove(me);
      players.delete(me.id);
      broadcastNear(me.x, me.z, { t: 'pleave', id: me.id });
    }
  });
});

// SIGINT = ctrl-c locally; SIGTERM = what hosts (fly.io, systemd, docker) send on
// deploy/stop — both must flush the world or a deploy loses unsaved progress
function shutdown(sig) {
  const n = saveWorldSync();
  console.log(`\n[${sig}] saved ${n} chunk(s). the hole persists. goodbye.`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — is another HOLE server running?`);
    console.error(`find it with: lsof -i :${PORT}   (or run with a different port: PORT=3014 npm start)`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const pct = ((meta.globalDug / meta.totalDiggable) * 100).toFixed(10);
  console.log(`HOLE listening on http://localhost:${PORT}`);
  console.log(`planet status: ${meta.globalDug.toLocaleString()} / ${meta.totalDiggable.toLocaleString()} voxels removed (${pct}%)`);
});
