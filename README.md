# HOLE — Planetary Removal Service

A pointless multiplayer digging game in the browser, in the spirit of *A Game About
Digging A Hole*: first-person voxel digging. Dig down, fill your backpack, return to
the surface, sell everything at the company store, buy a bigger shovel / backpack /
jetpack / helmet lamp, dig deeper.

Everyone digs in **one shared, persistent world** of **118,000 × 118,000 columns —
officially 999,000,000,000 blocks of earth** — divided into **55,696 "sites"**
(500×500 parcels, codes 0000-0000 through 0235-0235).
On join you enter a world code like `1234-5678` to land at a specific site — share
your code (shown in the HUD) and friends land right next to you. Blank code = the
busiest site. Every block anyone removes is gone forever (saved to disk); chunks
generate on demand, so only dug areas cost storage. Slow **company drones** spawn
wherever players are working and dig aimlessly alongside you.

## Run

```bash
npm install
npm start
# open http://localhost:3013
```

Friends on the same network: give them `http://<your-lan-ip>:3013`.

To put it on the internet: **see [DEPLOY.md](DEPLOY.md)** — a ready-made
fly.io setup (Dockerfile + fly.toml included, ~$5–8/mo, one always-on
machine with a persistent volume). It's a single stateful process, so
serverless platforms won't fit. The server flushes the whole world on
SIGTERM, so deploys and restarts never lose progress. Visitor traffic is
tracked server-side and shown on `/stats` (FRONT OFFICE section) — no
third-party analytics needed.

## Controls (mobile)

Open the same URL on a phone (landscape recommended). Touch devices get a
dedicated control scheme — no pointer lock needed:

- **Left half of screen**: dynamic virtual joystick (touch anywhere, drag to move)
- **Right half of screen**: drag to look · **tap to dig one swing** · **press &
  hold to dig continuously** (you can keep aiming while holding)
- **JUMP** button · **USE** button fires the hotbar item selected by tapping
  its slot (button shows only when you own that item) · **☠** hold to be
  buried (only appears when your pack is full)
- The bottom-center pill is the store button when you're at the surface
- Portrait shows a rotate prompt; Android locks to landscape automatically
- **Installable PWA**: "Add to Home Screen" gives a fullscreen, landscape-locked
  app with its own shovel icon (manifest + service worker; updates flow through
  automatically since the shell is network-first)

The client also drops to a lower pixel ratio and a tighter chunk bubble on
phones to keep the frame rate up.

## Controls (desktop)

- **WASD** move, **mouse** look; any movement key or click re-grabs the mouse
- **Click / hold click** to swing the shovel — each hit damages the block (fast
  clicking and holding are equivalent)
- **F** plant a torch where you're looking — the deep is genuinely dark, and
  torches are the only light. They're shared with everyone and persist forever
- **Space** jump (there is no jetpack; the company recalled them — dig stairs)
- **Hotbar** (bottom center): usable items — torches, dynamite, and whatever the
  company stocks next. Select with **1/2**, scroll wheel, or click; **E uses the
  selected item** (F/G still work as direct shortcuts). **B** opens the store
- Dynamite: 3-second fuse, falls to the ground before detonating, blows a
  3-block-radius sphere of earth (blocks destroyed, not collected). Standing
  next to your own charge kills YOU; it can never hurt anyone else
- **Fall damage**: the screen reddens as you fall — a hard red flash on landing
  means that one nearly killed you (10m+); 15m+ is death (full reset, grave,
  the works). No words, just the flash. Descend carefully
- **E** company store (surface only): sell everything, buy upgrades + torch bundles
- **Hold K** to be buried: when your pack fills up you choose — E to haul it to
  the store, or K to die with it. Your grave is a real grey block in the world
  labeled "R.I.P \<name\>" — anyone can dig it out to collect its value (the
  label disappears once collected). You get a death screen with your score,
  burial coordinates, and a share button; respawn is on the surface of the same
  site (an X marks your landing spot)
- **Tab** all-time leaderboard

## State

Everything persists in `data/`:
- `data/chunks/*.bin` — every modified 16³ chunk of the world
- `data/meta.json` — global dug counter, all-time leaderboard, and per-name
  player profiles (money, upgrades, deepest depth)

Delete the `data/` folder to regenerate a fresh planet.

## Pages

- `/` — landing page: live planetary counter, START DIGGING → `/play`,
  COMPANY REPORT → `/stats`, DAMAGE MAP → `/map`
- `/play` — the game itself (the PWA's start URL)
- `/map` — the scarred earth: a 236×236 heatmap of every wounded site, live
  active-site markers, hover for details, click to copy a world code

## Identity

The first claim code to use a name owns it forever (codes are auto-generated
and kept in your browser; the join screen shows yours — save it to play the
same name on other devices). Joining a claimed name with the wrong code is
refused.

## Economy (server-authoritative)

Your cargo, selling, and all purchases live on the server — the client can't
mint money, items, or upgrades. Grave values are appraised server-side
(wallet + cargo + $10). COMPANY INSURANCE ($2,500) preserves your shovel and
backpack through exactly one death.

## The deep

Natural caves thread the stone below 6m. Very rare company artifacts ($2,000)
lie below 20m. And at the very bottom of certain sectors, sealed into the
bedrock, there is a door. It does not open. Do not dig.

## Hired rigs

Once you've held $1,000 the store shows the rig offer; $10,000 hires an
autonomous digger (max 3 per player) that works at ~10,000 blocks/day forever —
including while you're offline. Its blocks count on your leaderboard record
(not your wallet). Purchases are server-authoritative; rigs persist across
restarts.

## /stats — the Company Report

`http://localhost:3013/stats` renders Form 27-B: workforce (employees, shifts,
peak concurrency, hours worked), casualties by cause, graves standing/robbed
and wealth interred, per-material dig ledger with gross values, equipment
issued, security-division counters (blocked cheat attempts), workforce origin
by country (IPs are hashed; geo lookups are best-effort via ip-api.com),
top removers, and system vitals. Auto-refreshes every 30s. Linked from the
join screen.

## Scale

Built for a global player base on a 1.775-quadrillion-block planet:

- **Interest scoping**: every gameplay event (positions, digs, torches, graves)
  only travels to players within a 3×3-sector neighborhood of where it happened.
  Crossing a sector boundary exchanges rosters and an authoritative object list
  for the newly visible area. The only truly global traffic is a 5-second
  heartbeat (counter, online, dig rate) and rare million-block milestones.
- **Pace meter**: the HUD shows the planet's live dig rate as time-to-completion
  ("gone in 843.7 million years at current pace"). Every 1,000,000th block
  removed is announced to the whole planet.
- **Persistence**: async, atomic saves; modified chunks shard across
  subdirectories (a flat dir dies long before the planet does); cold clean
  chunks evicted from memory on both server and client.
- **Abuse control**: dig token bucket (10/s sustained), move-message throttling,
  idle clients stop sending positions. Death wipes all equipment and money into
  the grave block, so dying is never a farming shortcut.
- **Going past one process**: a single Node process realistically carries
  5–15k connections. The path to 100k+ is already shaped by the sector model:
  run N processes, each owning a range of sites; route players at join time by
  world code (a tiny gateway or DNS-level shard map); keep the global counter
  and leaderboard in a shared store (e.g. Redis INCR); serve the static client
  from a CDN. Since gameplay never crosses more than one sector boundary,
  processes only need to share the global counter — sites are naturally
  independent shards.

## Notes

- World: 118,000×118,000 columns, ~70 blocks deep, bedrock floor. The surface
  has real biomes (continental-scale noise, identical on client and server):
  **swamps** — sunken terrain flooded with standing water and sandy mini
  islands (water can't be dug or blasted, but you can swim out and dig the
  lakebed right through it; falling into water never hurts); **deserts** —
  sand with sparse tall palms; dunes, dry grassland, grassland, parkland, and
  dense **forest**. The `/map` page is a true atlas of these biomes. Ores by
  depth: coal → copper → iron → silver → gold → amethyst → diamond, plus rare
  fossils ($500) at any depth below 10m.
- Depth fades to genuine pitch black by ~50m; torches mount on the face you're
  looking at, and drop to the floor if their supporting block is destroyed.
- A server-synced day/night cycle (40 real minutes per day, northern-summer
  asymmetric: ~28 min of daylight, ~12 min of night; sunset around 22:45 on the
  HUD clock) — everyone shares the same sky.
- Blocks are textured (16px procedural atlas: ore veins, stone cracks, bark,
  fossil ribs) and lit by real propagated skylight: sun floods down shafts and
  bleeds around corners with smooth per-vertex gradients.
- Anti-cheat: server-side earnings ledger (you can never bank more money than
  your blocks were worth), anti-teleport movement clamps, and an 8-digs/second
  budget per player.
- Faint ambient wind with birdsong by day and crickets at night, fading to
  silence over the first ~10m of the hole.
- The client renders through a floating origin, so coordinates in the millions
  stay precise; both client and server evict far-away chunks to bound memory.
- Player profiles are keyed by the name you enter — reuse the same name to keep
  your money and upgrades.
- The server trusts clients about money/upgrades (it's a pointless game among
  friends, not an economy).
