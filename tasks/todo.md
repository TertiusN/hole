# HOLE — multiplayer digging game

Mid-build pivot (per user): clone the *A Game About Digging A Hole* formula —
first-person 3D voxel digging with sell/upgrade loop. Mobile dropped for now.
Kept from the original brief: multiplayer shared world, full statefulness,
global "dig the entire earth" goal. Dropped: dig-or-die timer (replaced by the
clone's dig→sell→upgrade loop).

## Plan
- [x] package.json (single dep: ws)
- [x] server.js — HTTP static + WebSocket, 256×96×256 voxel world (~4.65M diggable
      blocks), 16³ chunks persisted to data/, global counter, leaderboard,
      per-name profiles (money/upgrades)
- [x] public/index.html — Three.js first-person client: chunk meshing, AABB physics,
      voxel raycast digging, particles, sfx, shop (sell + shovel/pack/jetpack/lamp),
      leaderboard, planetary progress HUD
- [x] README.md
- [x] Verify

## Review / verification results
- `node --check server.js` and client module both parse clean.
- Scripted ws client: join → init (256×96×256, 4,646,412 diggable), chunk fetch
  (4096 bytes, correct solidity), 3 digs echoed with incrementing global counter,
  profile save, leaderboard — all PASS.
- Persistence: SIGINT flush + cold restart reloaded global=3 and profile from
  data/meta.json + data/chunks/*.bin. Then wiped for a fresh planet.
- Server left running at http://localhost:3013 (LAN: http://192.168.1.142:3013).
- Not verified: WebGL rendering in an actual browser (no headless GPU here) —
  first manual playtest may surface visual issues.

## Round 2 (user feedback: not so square, trees, shovel, nice lighting)
- [x] Lumpy terrain: deterministic per-lattice-vertex displacement (crack-free across chunks)
- [x] Trees: trunk/leaf voxels in worldgen, diggable (wood $3), excluded from earth counter, tree-free spawns
- [x] First-person shovel viewmodel in overlay scene (own lights, wide FOV) with walk bob + dig swing
- [x] Lighting: baked corner AO, per-column skylight (dark tunnels, dappled tree shade),
      warm red-tinted cave shadows, headlamp = 0 on surface / warm underground, ACES tone mapping
- [x] Verified visually via headless Chrome screenshots (screenshots/surface.png, screenshots/cave.png)
- World data reset (old chunks had no trees / old lighting bake)

## Round 3 (feedback: no re-click, click damage, real shovel feel, more blocks, darkness + buyable lamps)
- [x] Mouse: movement keys re-grab pointer lock; movement works even unlocked; softer "MOUSE FREE" hint
- [x] Swing-based digging: discrete chops damage blocks (fast clicks ≡ holding), damage persists
      per block ~6s, crack overlay shows accumulation, bedrock clanks
- [x] Shovel feel: windup→strike→recover chop synced to the damage moment, impact particles,
      mouse-lag sway, proper walk bob
- [x] New blocks: sand (surface patches), copper $10 (d>6), silver $30 (d>25), amethyst $120 (d>45),
      fossil $500 (rare, d>10); ore glint floor so veins read in darkness
- [x] Lighting: headlamp REMOVED — darkness is real; torches are buyable consumables ($15/5, start
      with 3, F to place), shared + persisted server-side, nearest-6 get flickering point lights
- [x] Verified headless: swings broke blocks, torch placement/decrement/shop toast, torch persisted
      into a new session (screenshots/torch.png)
- World reset again (new ore gen)

## Round 4 (worlds/sectors, drones, max world size, torch mounting, pitch-black depths)
- [x] World: 5,000,000×5,000,000 columns ≈ 1.775 quadrillion blocks; 10,000×10,000 sites of 500×500
      (imul hashing for exact huge coords; census replaced by expected-value estimate)
- [x] Sites: join with world code (e.g. 1234-5678) → land there; blank → busiest site; active-sites
      list on join screen; HUD shows current site code to share with friends
- [x] Floating render origin (float32 GPU precision) + chunk-local vertices + client & server
      chunk eviction — verified clean rendering at x≈617,000
- [x] Company drones: ≤2 per active site (12 cap), spawn near players, wander/dig ~1 block per 3s,
      dig down sometimes, despawn when a site empties; appear as named players
- [x] Torches mount on the face you look at (wall lean-out, floor stand, ceiling refused);
      support destroyed → torch drops to the floor below (server-authoritative, broadcast)
- [x] Depth darkness: warm floor decays to near-black by ~50m, fog closes 120→28m, ambient dims;
      torch albedo floor kept so flames still light walls
- [x] Verified: ws test (site landing, busiest-default, drones digging), headless screenshots
      (site-with-drone.png, deep-dark.png, torch.png)
- Max possible with this architecture: ~2 billion × 2 billion columns (int32 hash range) ≈ 3×10^20
  blocks; beyond that the float64 dug-counter and hashing both need BigInt. 5M×5M chosen as the goal.

## Round 5 (day/night, spawn X, give-up tombstones, ambient sound)
- [x] Server-synced day/night (DAY_LEN 600s): sun curve drives ambient intensity + moonlight
      blue tint, sky lerps night↔day with dusk-orange twilight band, camera-following star
      dome (fog-immune, terrain-occluded), HUD clock (☀/☾ hh:mm), shovel light follows
- [x] X marker: red crossed planks on the ground in front of every spawn/respawn
- [x] Hold R (1.2s) to give up: server drops a tombstone (slab + R.I.P name tag) worth pack
      value + $10, capped 500 tombs; walking within ~1.6 blocks auto-collects; respawn at
      the surface of the same site with pack cleared
- [x] Ambient audio: looping filtered-noise wind (LFO gusts), birdsong when sun is up,
      crickets at night; master gain fades to silence across the first 10m of depth
- [x] Verified: ws lifecycle test (die → tombAdd $60 → reborn same sector → second player
      collects $60); headless shots (clock reads ☀12:00/☀17:45/☾23:16; night stars + X +
      drone; R.I.P grave) — saved to screenshots/dusk.png, night.png, grave.png
- Server left RUNNING (a live player had joined mid-session; data kept, no wipe)

## Round 6 (death redesign: K to be buried, splash + share; EADDRINUSE fix)
- [x] K replaces R (hold 1.2s); full pack shows red prompt "E sell · K be buried"; full-pack
      dig toast updated
- [x] Death splash: HERE LIES <name>, blocks removed this life (me.lifeDug), pack value
      buried, deepest point, burial site code + block coords; SHARE (navigator.share →
      clipboard fallback) + DIG AGAIN (applies deferred respawn); input fully gated via
      uiOpen = shopOpen || deadOpen
- [x] Bug found via screenshot: player auto-collected their own fresh tomb while the splash
      was open (body still at grave). Fixed client-side (no collecting while dead) and
      server-side (own-name tombs blocked for 15s after death)
- [x] EADDRINUSE crash returned because ws re-emits http errors on the WebSocketServer and
      throws before the friendly handler runs — added wss.on('error', noop); verified a
      second instance now prints the friendly message and exits 1
- [x] Verified headless: splash renders with correct stats/coords, respawn closes it;
      screenshots/death-splash.png

## Round 7 (painted X, slower days)
- [x] X marker rebuilt as a decal painted on the top face of the actual ground block: same
      per-vertex displacement as the terrain mesher so it hugs the lumpy surface (canvas
      texture, Lambert, polygon-offset), and removed the moment that block is destroyed
      (checked in setVoxelLocal — works for own digs, other players, and drones)
- [x] Day/night cycle slowed 10min → 40min per full day (server constant; clients sync)
- [x] Verified headless: decal renders on the block (screenshots/x-marker.png), digging the
      block removes it (xinfo() === null)

## Round 8 (diggable tombstones, humanoid diggers)
- [x] Tombstones are now real voxels (type 16, grey, glints in dark): dying sets the block
      via a new 'set' broadcast; digging it pays the bounty (tombGot) and removes the
      floating R.I.P label; walk-into-collect + server 'collect' handler removed; full pack
      doesn't block grave-digging; own fresh grave protected client- and server-side
- [x] Remote players/drones are blocky humanoids: hard hat, head, colored shirt/pants,
      pivoting arms+legs with walk cycle (speed inferred from movement), mini shovel in
      right hand, chop animation for ~0.9s whenever a 'dug' broadcast carries their id
      (drones now attribute digs via by: bot.id)
- [x] HOLE_DATA env var: test servers run on PORT=3014 with an isolated data dir — never
      again sharing the user's live data/ (user's own npm-start server was running; left it
      untouched, all verification done against the isolated instance)
- [x] Verified: ws test (die → v16 set → dig → $77 bounty → label removed);
      screenshots/worker.png (humanoid drone in its trench)
- NOTE: user must restart their npm-start server to pick up today's server changes

## Round 9 (scale pass for 100k+ users + death hardening)
- [x] Interest scoping: players indexed by sector; broadcastNear (3×3 neighborhood) for
      pos/dug/set/torch/tomb/pjoin/pleave; sector-crossing handshake exchanges pjoin/pleave
      rosters (players + drones) and an authoritative 'area' torch/tomb payload (client
      reconciles stale objects); init roster/objects area-filtered
- [x] Global traffic reduced to a 5s heartbeat (counter/online/rate) + million-block
      milestone broadcasts (client toast + chime)
- [x] Pace meter: server tracks rolling blocks/min; HUD shows "gone in X years at current
      pace" (verified: '843.7 million years')
- [x] Persistence: async atomic saves (tmp+rename), sharded chunk dirs (cx>>6_cz>>6) with
      legacy flat-path read fallback, eviction only touches clean chunks; sky-chunk gen
      fast path
- [x] Abuse/scale: dig token bucket 10/s, move throttle 35ms, client suppresses idle pos
      sends (2s heartbeat), client prunes others unseen 15s, permessage-deflate ≥1KB,
      leaderboard cached 30s, torch cap 100k / tomb cap 20k (sector-indexed)
- [x] Death hardening (user): dying resets ALL equipment + money + records (server resets
      profile authoritatively); entire fortune (pack + cash + $10) goes into the grave block
- [x] Verified on isolated 3014 instance: scoping (far site blind to events), crossing
      handshake, death reset on reconnect, heartbeat, adjacent tombstone visibility,
      1,000,000-block milestone fired, sharded chunk files written
- NOTE: user's npm-start server needs another restart to pick this up

## Round 10 (mobile)
- [x] Touch scheme: dynamic virtual joystick (left 45%, analog magnitude feeds movement),
      drag-look on right side (with viewmodel sway), button cluster: hold-⛏ dig, ▲ jump/jet,
      🔥 torch, $ store, hold-☠ bury; multi-touch via touch identifiers; touch-action none
- [x] No pointer lock on touch: lockMouse() sets locked=true; exitPointerLock guarded;
      keyboard prompts swap to button glyphs; help hidden; HUD compacted ≤860px;
      shop gets a CLOSE button (works for desktop too); PWA-ish meta tags
- [x] Mobile perf: pixel ratio cap 1.5, chunk radius 3 on coarse-pointer devices
- [x] Verified via Chrome mobile emulation (844×390, hasTouch): touch UI activates,
      holding ⛏ dug 4 blocks, layout screenshot saved (screenshots/mobile.png)

## Round 11 (mobile redesign after real-iPhone feedback)
- [x] Removed the scattered button cluster: dig is now gesture-based on the right half —
      tap = one swing, press & hold (170ms, <14px movement) = continuous dig while still
      aiming, drag = look. Only ▲/🔥/☠ remain, stacked on the right edge with
      env(safe-area-inset-*) so the iPhone notch/home bar can't cover them
- [x] Store button removed — the bottom-center prompt pill is now tappable ("TAP HERE —
      COMPANY STORE"), styled as a button on touch
- [x] Mobile styles gated on body.touch class instead of max-width media query (iPhone
      landscape is >860px wide, which is why the desktop help text leaked through)
- [x] Overlays scroll (overflow-y auto + touch-action pan-y + margin:auto centering) for
      short landscape viewports
- [x] Landscape default: requestFullscreen + screen.orientation.lock('landscape') on join
      (Android); portrait shows a "ROTATE TO LANDSCAPE" nag (iOS can't lock)
- [x] Verified in emulation: tap dug exactly 1 block, 2s hold dug 3 more, portrait nag
      appears, clean landscape layout (screenshots/mobile.png)

## Round 12 (PWA + contextual mobile buttons)
- [x] PWA: manifest.json (fullscreen, orientation landscape, theme #14100a), sw.js
      (network-first with cache fallback, /health excluded), pixel-art shovel icons
      192/512 generated via hand-rolled PNG encoder (zlib, no deps), served from a static
      whitelist in server.js; SW registration in client; apple-touch-icon + theme-color
- [x] JUMP is a labeled rounded-rectangle button (amber tint)
- [x] Contextual buttons: 🔥 only when me.torches > 0; ☠ only when pack is full
      (driven from updateHud, touch only — K still works anytime on desktop)
- [x] Verified: all 4 PWA assets serve 200 with correct types, SW registers, JUMP text,
      torch visible at 3 torches, bury hidden with empty pack (screenshots/mobile.png)
- NOTE: server.js changed (static routes) — user must restart npm start

## Round 13 (999B world, north-summer days, no jetpack, fall damage, anti-cheat, dynamite,
## textures, propagated lighting landed, PWA letterbox fixes)
- [x] World resized 5M² → 118,000² with official goal fixed at 999,000,000,000 blocks
      (55,696 sites, codes ≤ 0235); out-of-bounds torches/tombs purged at boot
- [x] Day/night: 70/30 split (28min day / 12min night), clock maps 06:00→22:00 daylight
- [x] Jetpack removed everywhere (server forces jet 0); Space = jump only
- [x] Fall damage: red vignette ramps past 10m; land ≥15m warning toast; ≥20m death via
      the standard grave flow (verified: 22m fall → splash)
- [x] Anti-cheat: meta.earned ledger (dig values + collected tombs) caps saved money and
      grave value (verified: $999,999 claim stored as $200); move step clamp 30; dig
      bucket 8/s (dig bots updated to walk legally — the old teleporting digbot was
      silently blocked, which masked itself as a lighting bug)
- [x] Dynamite: $250, G/🧨 to place, server-side 3s fuse, 3.5-radius blast (bedrock+graves
      survive), owner-only lethality (verified: bomber died cause=dynamite, bystander
      unharmed), boom broadcast + client sphere-clear + shake + thump; ≤3 live per player
- [x] Texture atlas: 17 procedural 16px tiles (runtime canvas, nearest-filtered); mesher
      UVs; vertex colors now carry light only
- [x] Propagated skylight verified end-to-end: shaft cell light 15, room 12, screenshot
      shows sunbeam gradient (screenshots/lighting-shaft.png, textures-surface.png)
- [x] Sky above world ceiling (y≥96) was solid — now air (client+server)
- [x] PWA letterbox: body position:fixed + -webkit-fill-available + dvh + scroll pinning
      on orientation change; SW cache bumped to v3 (needs real-device confirmation)

## Round 14 (no floating lamps, dynamite presentation)
- [x] Torches are now DESTROYED when their support block goes (reanchor/drop removed) —
      no unattached lamps possible; dynamite's torch pass already deleted outright
- [x] Dynamite radius set to exactly 3 (user spec: 3 up/down/left/right, a circle);
      surface blast measured 57 blocks — correct clipped sphere
- [x] Charge visual upgraded: 3 banded red sticks, angled fuse, blinking tip (yellow/red),
      accelerating beeps; explosion now has an expanding fireball mesh + orange point-light
      flash (0.45s) + triple particle burst + shake + thump
- [x] Verified: charge renders ("3 SECONDS. RUN."), adjacent owner died (💥 splash, $200
      grave), 12-blocks-away survived, clean crater (screenshots/dynamite.png, crater.png)
- NOTE: user's "dynamite doesn't work" was almost certainly their npm-start server running
      pre-dynamite code (old server silently ignores the message) — restart required

## Round 15-16 (falling dynamite, skew tolerance, hotbar)
- [x] Dynamite falls: server computes rest cell (re-drops at detonation if undermined),
      dynAdd carries id+fy, client animates the drop with landing dust/thud; charges keyed
      by id; verified: placed at y78 → rested y71 → exploded at ground
- [x] "Falls through the map" diagnosed as version skew (stale SW client + new server);
      client now tolerant: fy clamped, boom removal falls back to column match; placement
      requires an aim target (no blind feet placement)
- [x] PWA letterbox: swapped black-translucent → black status bar and manifest display
      fullscreen → standalone (both documented iOS letterbox triggers); SW v5; join-screen
      vpdbg line (vp/vv/scr/sab/standalone/version) for on-device diagnosis
- [x] Hotbar: ITEMS registry (torch, dynamite — future items just append), slots with
      counts/keybinds bottom-center, select via 1-9/scroll/click/tap, E = use selected,
      B = store (F/G legacy shortcuts kept); mobile: slot taps + single USE button
      (contextual), old per-item buttons removed
- [x] Verified: E placed torch (8→7), Digit2+E placed dynamite (1 live), selection
      highlight moves; screenshots/hotbar.png

## Round 17 (/stats company report)
- [x] meta.stats ledger (persisted): joins/peak/hours, deaths by cause, grave economics,
      digs by players/drones/dynamite, per-block-type counts, trees felled, tombs exhumed,
      equipment issued (upgrade deltas from profile saves), torches/dynamite placed,
      security counters (rate-limit/teleport/money-clamp rejections), sites visited,
      deepest ever, boots/uptime
- [x] Geo: connection IPs hashed (sha1/12) → best-effort country via ip-api.com (5s
      timeout, silent failure, private ranges = "Local Network"); counts only, no raw IPs
      stored
- [x] GET /stats: server-rendered Form 27-B in the game's pixel aesthetic, 9 panels +
      headline progress, auto-refresh 30s, linked from join screen
- [x] Verified: counters populated from live activity (screenshots/stats.png)
- KNOWN GAP: torch/dynamite QUANTITIES in profile saves aren't earnings-validated (only
      money is) — a hacked client can claim free consumables (visible in the report as
      inflated "torches acquired"). Real fix = server-side purchases; deferred.

## Round 18 (hired rigs, /play + landing)
- [x] Hired rigs: server-authoritative purchase ($10k, offer visible from $1k balance,
      max 3/player), spawn near owner, hue 205, "<NAME>'S RIG" tag; dedicated rigAct digs
      nearly every action at 8.64s cadence (~10k blocks/day); digs credit owner's board
      (not wallet); persist in meta.hired (position-synced on save), survive restarts;
      exempt from ambient fleet despawn/quotas; stats rows (rigs on payroll, rig labor)
- [x] Verified: 2 hires ($25k→$15k→$5k), third refused, rigs survived restart and dug
      on cadence
- [x] Routes: / = landing page (live counter polling /health, START DIGGING → /play,
      COMPANY REPORT → /stats, rotating taglines), /play = game; manifest start_url
      /play; SW v6 caches both (screenshots/landing.png)

## Round 19 (identity, deep content, /map, server economy + insurance)
- [x] Claim codes: first sha1(token) to use a name owns it (meta.auth); joinFail bounces
      imposters back to the form; client auto-generates & stores token, editable input
- [x] Worldgen: spaghetti caves (two trilinear-noise level surfaces, d>6, y>4 so crust and
      bedrock stay sealed); artifacts v17 ($2000, d>20, 0.04%); THE DOOR v18 — 3×3×3
      sealed structure at y2-4 in ~3% of 512-cells, indestructible (dig/blast refused),
      clank + "THE DOOR DOES NOT OPEN"; atlas tiles for both
- [x] Server-authoritative economy: per-session server cargo (svInv, capped by pack tier),
      'sell'/'buy' messages with server price table, save handler reduced to depth records,
      grave value appraised server-side; insurance item ($2500, preserves shovel+pack for
      one death, consumed)
- [x] /map + /mapdata: meta.digBySite per-sector dig counts (players/drones/blasts),
      canvas heatmap with hover tooltips, click-to-copy world code, live active sites
- [x] Verified end-to-end: theft rejected, sell $4=$4 exact, $999,999 claim inert,
      insured MK-IV survived death, 1029 cave voxels + 9 artifacts in 6 chunks, door
      present & undiggable, map renders scar (screenshots/map.png)

## Round 20 (colorful map)
- [x] /mapbase: per-site biome band from two-octave continental noise (wavelengths 28 & 9
      sites — the raw 8-block height noise was uncorrelated at site scale and rendered as
      confetti), 7 bands deep-water→forest, cached server-side + Cache-Control 1d
- [x] Map page: base terrain layer with 3-shade jitter per band, damage scars + active
      sites overlay on top, terrain name in tooltip, two-row legend
      (screenshots/map.png)
- NOTE: map biomes are presentational (survey tones) — in-game block gen is unchanged;
      wiring the same regional noise into worldgen (sandy dune sites, denser forests,
      real water) is a candidate future round

## Lessons
- Do NOT leave a background dev server running at the end of a turn — the user runs
  `npm start` themselves and collides on the port. Always pkill and leave the port free.
- The Bash tool's job table (`kill %1`) does not persist across tool calls —
  kill background processes by PID/pkill, not job specs.

## Round 21 (real biomes: swamps with islands, deserts with palms)
- [x] Biome field (2-octave regionNoise, 7 bands): swamp / desert / dunes / dry grassland / grassland / parkland / forest — identical on client & server
- [x] Swamps: surface depressed 4 blocks, standing WATER (block 19) to y=71, sandy islands poke through, trees only on islands
- [x] Water: undiggable/unblastable, passable, transparent to dig-raycast (dig the lakebed THROUGH it), swim physics (float, Space to surface), no fall damage into water, underwater teal fog
- [x] Deserts: all sand, sparse tall palm trees (6–8 trunk); tree density per biome (forest ~20× desert)
- [x] Spawns clamped above water; /map + landing map now sample the true biome per site (legend updated)
- [x] Verified on isolated :3014 — swamp vista (islands + water render), underwater fog, dug 3 lakebed blocks through water without dying, desert palms, forest density, new /map
- NOTE: worldgen changed → old data/chunks mismatch. Recommend `rm -rf data/chunks` (KEEP meta.json).

## Round 22 (deployment kit)
- [x] Dockerfile (+.dockerignore) — node:22-slim, ws only, HOLE_DATA=/data
- [x] fly.toml — 1 always-on machine (autostop OFF, min 1), 1GB RAM, volume at /data, /health check, kill_timeout 30s
- [x] SIGTERM handler — flushes chunks + meta.json on deploy/stop (verified: kill -TERM → "saved N chunk(s)", views survived restart)
- [x] Self-hosted visitor analytics — page views (landing/play/map/stats) + visit→shift conversion in meta.stats.views, rendered as FRONT OFFICE section on /stats (verified via curl)
- [x] DEPLOY.md — signup → volume → deploy commands, custom domain, backups (daily fly snapshots + tar pull), NEVER-scale-past-1 warning, cost table

## Round 23 (underground storage crates)
- [x] Block 20 STORAGE CRATE — buyable $420 (max 1 carried), placeable only underground on solid ground, holds 420 units
- [x] E on a placed crate dumps your whole pack in for $0 — one-way, server-authoritative, contents unrecoverable (digging the crate destroys everything inside)
- [x] Floating "CACHE n/420" label like tombstones; crates survive dynamite; area/init sync; stats rows on Form 27-B
- [x] Verified full lifecycle on wire test (buy, dup-refuse, bad-place-refuse, place, dump 3/420, empty-refuse, smash)

## Round 24 (shovel progression + swamp surface rule)
- [x] Tiered first-person viewmodel: MK-I knobby STICK → MK-II wood plank scoop → MK-III steel → MK-IV bronze/dark hardwood → MK-V obsidian blade with glowing diamond tip; rebuilds via updateHud on any tier change (buy, death, insurance)
- [x] HUD shows tier name (STICK MK-I … DIAMONDEDGE MK-V); HOLE.shovel(t) debug hook
- [x] Swamp surface rule: head above the waterline = at the surface (store works, DEPTH 0m); depth in swamps measured from water level, not lakebed; fixed shadowing bug (tick-local const myDepth vs helper → renamed depthNow)
- [x] Verified: 5 tier screenshots, floating-on-water state {depth 0m, store prompt on, 0 page errors}

## Round 25 (ladders + store fix + share polish)
- [x] LADDER RUNGS: $150 each, hotbar slot 4 (🪜), bolt to walls only (server-validated), persistent + shared like torches, destroyed when the anchor wall is dug/blasted, sector-scoped sync
- [x] Climb physics: SPACE up / SHIFT down / slow controlled slide, no gravity or fall damage while on a rung; verified full escape loop (dug 19m straight down, ratcheted 11m back up on 6 rungs)
- [x] STORE BUG (user report: auto-bought dynamite): buy buttons kept keyboard focus → later Space/Enter (with key auto-repeat) re-triggered them. Fixed: blur on click + 250ms server-side purchase debounce (verified: 2 instant buys → exactly 1 charged)
- [x] Share/unfurl: OG + Twitter card meta on all 4 pages, og.png (1200×630 gameplay shot), favicon.ico + icon links
- [x] Mobile: ☠ button → "BURY ME" text pill
- [x] Debug hooks: HOLE.buy/vox/ray/state/shovel; NOTE: dig-straight-down "bug" investigated — player hitbox perched on shaft lip when off-center; by design

## Round 26 (torch/dyn ledger fix)
- [x] User report: torch counts jumping (5→7→18 across $15 bundles). Cause: dual ledger — server never decremented torches on placement, but every 'bought' snapped the client back to the server's stale count +5
- [x] Fix: placements now spend server inventory (torch: prof.torches--, dynamite: prof.dyn--, both validated >0 before placing) — also closes the infinite-torch/dynamite hacked-client hole
- [x] Wire-verified: start 3 → buy = 8 → place 2 → buy = 11 (not 13); arming dynamite with 0 owned is rejected

## Round 27 (the paper trail + grave-money fix)
- [x] LORE: block 21 "memo slate" (1/5000 blocks below 4m, deterministic worldgen), 28 Company memos in 4 depth bands (onboarding → logistics → the Structure → the doors); memo id deterministic per position; $50 finder's fee via pack
- [x] Memo overlay ("INTERNAL — DO NOT CIRCULATE"), J-key DOSSIER of recovered memos; lore survives death; init ships owned memo texts; memos blast-immune; stats row "memos unearthed (N of 28 in circulation)"
- [x] GRAVE MONEY BUG (user report): tombGot only credited the client display + earnings ledger, never prof.money — the next money sync (selling) wiped it. Fixed: bounty goes into the server wallet, tombGot carries authoritative balance. Wire-verified: $100 + $200 grave → $300 survives selling
- [x] Wire-verified lore: located real memo slate in chunk data, walked, dug → "MEMO 0524 — QUARTERLY" fresh 1/28

## Round 28 (holeplanet.com + map polish)
- [x] DOMAIN: holeplanet.com live on Fly — certs added, A/AAAA (+www) records created via vercel CLI into Vercel DNS, verified https + wss end-to-end; canonical OG/share URLs switched (share text uses location.origin); www cert pending DNS propagation (self-issues)
- [x] ← HOME button pinned top-left on /stats and /map
- [x] Damage colorway: violent high-contrast heat scale — scratched #1e6fff blue, excavated #8b2be2 purple, 10k+ #e91e63→#ff1717 red, live diggers #00ffe1 cyan

## Round 29 (H.O.L.E. + personnel files)
- [x] Landing h1 → "H.O.L.E." — the expansion is NOT printed; it's buried: MEMO 0007 (band 1, marketing being coy) and MEMO 0991 (band 4: "Human Operated" was a promise to the buyer — it must be dug by hand, it matters to them that it costs us something). Lore canon now 32 memos, 8 per band
- [x] /report — Form 27-B/E personnel file: no name → RECORDS DESK lookup; any employee name → extraction record (blocks/earnings/balance/deepest/burials), equipment, clearance level (rises with memos recovered), graves currently standing with sites+values, ON SITE/OFF DUTY
- [x] prof.deaths counter (survives resets); PERSONNEL FILES button on landing; lookup linked from death splash ("VIEW YOUR PERSONNEL FILE"); page views tracked

## Round 30 (compass)
- [x] Compass in the top-left panel next to the clock: cardinal + degrees (N=map-up/-z), amber, updates per frame; verified all four cardinals + NE at exact yaws

## Round 31 (flare gun)
- [x] FLARE GUN $200 one-time (hotbar slot 5 🔫): E fires a violet signal star — climbs 120 blocks over 3s with sparking tail, burns ~25s with flicker, fades; fog-immune sprites (visible across the 3×3-sector neighborhood); 30s server-side cooldown ("the barrel is still hot — Ns")
- [x] Broadcast to neighborhood with shooter's name ("🟣 X fired a flare — look up"); lost on death like other equipment; stats: flare guns issued / signals fired
- [x] Verified: purchase, cooldown rejection, observer client received broadcast, night screenshot from 80 blocks

## Round 32 (flares: consumable + voxel star)
- [x] Flares are consumable SHELLS: $200 each (×5 $1,000 bundle), server decrements on fire (flareCnt sync), cooldown 10s (cost is the limiter), launcher "provided free of charge"
- [x] Voxel star render: white-hot core cube + violet plus-shell + dim corner studs, tumbling rotation + pulsing core, voxel spark tail on climb, embers dripping while burning, fade-out; still fog-immune
- [x] Wire-verified: buy ×5 → 5/$1000 exact, fire → 4 left, refire → cooldown reject without consuming; distance screenshot confirms chunky cubes read at range

## Round 33 (owned-only hotbar)
- [x] Hotbar shows only items with count > 0 (registry can grow forever); number keys / scroll operate on visible slots; selection auto-moves off emptied items; bar hides entirely at zero items; shop "slot N" copy made generic
- [x] Verified: fresh player = torches only; acquiring dynamite adds a second slot live

## Round 34 (jobs board, promotions, name policy, bulletin, socials)
- [x] JOBS signpost (hand-lettered plank, faces your X, within 5 blocks, personal, destroyed if its ground goes) → E/USE opens listings: 3 seeded offers (board pos + day), tiers weighted by rank
- [x] Server-authoritative contracts: dig/collect/depth/torch/blast/sell/grave/dump/REFER kinds; progress via jobEvent hooks in existing handlers; one at a time; abandon allowed; job dies with you
- [x] Promotions: INTERN→DIGGER(3)→EXCAVATOR(7)→FOREMAN(14)→SITE MANAGER(25)→DIRECTOR OF DESCENT(40)→VP OF REMOVAL(60); $500×rank bonus; neighborhood announcement; rank on name tags (interns get nothing), leaderboard, personnel file
- [x] Referral contracts: pay when a genuinely-new digger (no profile, no board entry) lands in your 3×3; wire-verified
- [x] Name policy: leet-normalized blocklist at join ("violates the employee handbook") + boot scrub of pre-existing offenders (graves → REDACTED); verified N1GG3R/f4gg0t refused, DlGGER/digger-dan pass
- [x] /release-notes "SITE BULLETIN" page + landing button; Telegram button on landing + join screen (NEEDS PUBLIC t.me LINK — current URL is owner-view only)
- [x] Right-click = use (same as E); closing jobs/memo/dossier re-locks the pointer like the store does
- [x] Wire-verified: offers deterministic, torch contract 3/3 → paid $61 → promotion DIGGER +$500; second take refused

## Round 35 (invite links + landing layout)
- [x] Invite links /play/XXXX-XXXX?by=name: prefill site code, join-screen recruiting banner, server-rendered custom unfurl ("JERRY is digging at site … — join them"), ?by credits the sender's recruiting contract from ANYWHERE (players scan), neighborhood rule kept as fallback
- [x] Tap the HUD site code → invite link copied (share sheet on mobile); death-splash share text now carries the invite URL
- [x] Landing redesign: one dominant START DIGGING CTA + quiet secondary pill nav
- [x] Verified: unfurl variants (by/site/plain), cross-site referral payout, client prefill + banner

## Round 36 (sell bug + URL-as-invite)
- [x] USER BUG "sell does nothing": anti-teleport clamp was a black hole — one legit >30-block jump (fall during a network stall; burst arrival + flood-drop) desynced server position PERMANENTLY → all digs failed reach → server pack empty → sell sold nothing. Evidence: 3,833 tpBlocked on prod
- [x] Fix: clamp is speed-aware (allowance 30 + 60/s horizontal, 30 + 45/s vertical, capped 10s) and rejections send authoritative 'resync' (client snaps to server pos, 1/s throttle). Wire-verified: 500-block cheat rejected+resynced; 2.5s-stall fall accepted; dig+sell healthy after
- [x] Invite UX redo: tap-to-copy was unclickable (pointer lock + HUD pointer-events:none). Now the ADDRESS BAR is the invite link — history.replaceState keeps /play/SITE?by=name live as you move between sites

## Round 37 (signposts + refer UX + HUD cleanup)
- [x] BLANK SIGN $100 (×5 bundle): 12-char player signposts, solid ground required, faces its author, persists/synced like torches, falls when ground dug/blasted; charset [A-Z0-9 -!?.'], uppercased
- [x] Rank gate: store row hidden + server-refused below rank 1 ("signage requires at least one promotion")
- [x] Filter: name-policy slur filter + sign profanity list incl. common misspellings (fuk/fck/sht/btch…); refused attempts don't consume a sign
- [x] Sign-writing overlay (input owns the keyboard, Enter plants, Escape cancels)
- [x] Removed HUD invite-hint line; the refer contract listing/current-job now explains the URL mechanic
- [x] Wire-verified: intern refused, foreman ×5 buy, FUK U refused, "danger!"→"DANGER!" planted, ground dug → sign fell

## Round 38 (board courier, single flares, ESC relock)
- [x] REPLACEMENT JOB BOARD $50 in store — planted next to you on purchase (works underground: uses your current y, finds solid ground nearby); replaces the old board
- [x] Flare shells: single $200 button only (bundle removed per feedback)
- [x] ESC-close limbo fixed: browsers refuse pointer lock from Escape, so closes set wantRelock — paused overlay suppressed, very next key/click re-locks instantly

## Round 39 (contract sets)
- [x] Jobs redesigned as CONTRACT SETS: persistent per-player batch of 3 (seeded name+seq, tiered to rank), completions marked ✓ on the board, ALL 3 required to clear the set → +$150 bonus → fresh set posted (regenerated at new rank)
- [x] Reroll: any untouched contract swappable for $150 (pressure valve for refer/hard jobs; money sink); abandon returns the job to the set unmarked
- [x] Board no longer seed-shopped (bx/bz removed from protocol); stats: sets cleared + rerolls
- [x] Wire-verified full loop: torch✓ → dig48✓ → reroll dig230→refer→depth27 → ✓ → SET CLEARED + PROMOTED → new set with fresh jobs

## Round 40 (personnel file: join button + field telemetry)
- [x] ⛏ JOIN THEIR DIG button on /report — live site when ON SITE NOW, last-known excavation otherwise (prof.lastSite tracked at join + sector crossings); links to /play/SITE
- [x] Per-player lifetime telemetry (survives death — HR keeps the file, not the body): shifts, seconds on shift, odometer (accepted-move distance), per-material collection ledger
- [x] Absurd stats: share of planet at 12 decimals, estimated shovel swings, unreimbursed calories, blocks/shift, projected solo completion in years (bring snacks)
- [x] Wire-verified: wander+dig → report shows site button, 20m odometer, 1 shift, dirt ledger

## Round 41 (emotes)
- [x] APPROVED WORKPLACE EXPRESSIONS: 9 emoji emotes, rank-gated (interns: 👋❤️⛏; DIGGER 😂❓; EXCAVATOR 😱🪦; FOREMAN 💀; SITE MANAGER 🎉), server-validated + 1.5s cooldown, broadcast to 3×3 neighborhood
- [x] T opens picker (locked = greyed w/ rank tooltip; digits 1-9; T-T repeats last); mobile 😀 button; sender gets toast feedback
- [x] Bubbles: pixelated emoji sprite pops above the head, rises + fades over 2.5s; 👋/🎉 also animate the limb rig (wave / both-arms party)
- [x] Stats: expressions filed + most-common icon on Form 27-B; SITE BULLETIN entry
- [x] Wire-verified (gating/broadcast/invalid ignored) + two-browser screenshot of the wave

## Round 42 (handbook + full emote animations)
- [x] ? / opens the EMPLOYEE HANDBOOK (FORM 27-B/H · "read during unpaid breaks only") — full controls + systems reference, scrollable sheet, ESC/? closes, corner hint now says "? handbook"; fixed id collision with the old #help hint element
- [x] Every emote animates the body now: 👋 wave · ❤️ arms reaching out · ⛏ demonstrative chopping · 😂 shaking with laughter · ❓ confused lean · 😱 arms up leaning back · 🪦 mourner's bow · 💀 zombie shuffle · 🎉 full celebration; body tilt resets cleanly when the feeling passes

## Round 43 (dig desync fix — "blocks reappear on refresh")
- [x] Root cause: client digs optimistically with no rollback; server rejected digs SILENTLY (rate/reach/invalid) → ghost air until refresh. Worst trigger: the move flood-filter kept the OLDEST position during network jitter bursts, so digging-while-descending failed reach constantly for laggy players
- [x] Fix 1: every move message updates authoritative position (only the pos REBROADCAST is throttled to ~28/s)
- [x] Fix 2: every rejected dig sends a corrective {set} with the true voxel — ghost air heals instantly instead of on refresh
- [x] Fix 3: reach 8→9 (latency grace)
- [x] Wire-verified: jitter-burst descent dig ACCEPTED (previously rejected); 40-block cheat dig rejected WITH corrective set (v=3 stone restored)
- NOTE: US instance NOT added — single stateful process; a second machine = a second planet. Fly edge already terminates TLS near players. Real multi-region = site-range sharding (documented in README), not needed at current scale. Disk: async saves every 10s + SIGTERM flush; deploys lose nothing, hard crash loses ≤10s

## Round 44 (emote quick-numbers)
- [x] Hotbar-style number badges (1-9) on the picker buttons, desktop only — open with T, tap the digit, feeling dispatched

## Round 45 (DoS hardening — protects the prime directive)
- [x] Security audit result: planet progress CANNOT be reset/reduced via protocol (globalDug monotonic, save handler ignores client money/upgrades, dig only writes air, economy server-authoritative). Only progress risk was a CRASH (bypasses SIGTERM flush, loses ≤10s) via missing DoS guards
- [x] maxPayload 64KB; per-connection message token bucket (20/s sustained, 40 burst, drop-then-kick); per-IP connection cap 24; per-socket error handler (the maxPayload reject was itself crashing the process)
- [x] Wire-verified: 200KB payload→closed 1009, 3000-msg flood→kicked, 30 conns/IP→6 refused, legit client digs fine after, zero crashes

## Round 46 (world map + snacks)
- [x] /stats WORKFORCE ORIGIN: replaced the growing country list with a server-rendered 8-bit SVG world map — ellipse continents, amber dots scaled by digger count, top-6 line + unmapped tally below. GEO centroid table (~70 countries incl. ip-api aliases)
- [x] COMPANY SNACK: $15 consumable (×5 bundle), rank>=1 gated (server + shop row), 1.5s cooldown, purely cosmetic
- [x] Snack animation: food sprite (random of 9) slides in from screen-left in vmScene, 3 nibbles + shrink, slides out over 2.8s; shovel untouched. Others see a 🍪 bubble (snackNear). Stats: snacks vended/consumed
- [x] Verified: intern refused, digger ×5 buy → eat decrements, world map renders recognizably, sandwich animation screenshot

## Round 47 (starstone + deployable store)
- [x] STARSTONE (block 22): magenta gem, worldgen d>60 & r<0.0006 (~10x rarer than diamond), $50,000; atlas crystal, glints in dark, isEarth (counts), special dig toast
- [x] STORE OUTPOST KIT (block 23): $99,999 hotbar 🏪, placeable ONLY on bedrock (below===8), shared world object (crate pattern), block+"COMPANY STORE" label, undiggable + blast-proof (permanent), STORE_CAP 5000 evict-oldest
- [x] nearStore() opens the shop anywhere (fixes "no surface once deep"); prompt + toggleShop gate updated; anyone can use any deployed store
- [x] Wire-verified: buy $99,999 → non-bedrock refused → dig floor + deploy on bedrock (kit consumed) → store block undiggable; shop screenshot confirms both rows

## Round 48 (stop deploys rugging unsold cargo)
- [x] ROOT CAUSE: me.svInv/svInvN transient, never persisted → every restart handed reconnecting players an empty pack
- [x] saveCargo(p) mirrors live pack into profile; saveAllCargo() in saveWorld (10s) + saveWorldSync (SIGTERM/deploy); saveCargo on ws.close, sell, death, dump; restore from profile on join; profile defaults + death-reset include svInv
- [x] Wire-verified: dig→SIGTERM→restart→reconnect restores cargo ($6 sellable, not rugged); sell→SIGTERM→reconnect = empty pack + money kept (no dupe)

## Round 49 (retire ambient drones)
- [x] Ambient drones (2/site, cap 12) disabled — too many. Fleet interval now only despawns any non-hired bots; spawnBot/droneAct left as dead code (harmless), ambient dig loop is a no-op (skips hired)
- [x] Hired RIGs untouched — remain the only automated diggers (rigAct loop + meta.hired persistence intact)
- [x] Verified: 0 ambient drones after 9s at an active site; seeded hired rig still present ("BOSS'S RIG")

## Round 50 (spawn fix, jetpack, dynamite gate, rig-follow)
- [x] SPAWN: was dropping players at generated-surface height even where terrain was dug out → fall in and die. Now spawnPos only picks INTACT surface columns (getVoxel at surf !== air); fallback lands on topSolidY (real ground) — never a lethal sky-drop
- [x] JETPACK: $999 one-time (prof.jet) + fuel $99/9s (prof.jetfuel); hold SPACE mid-air → thrust up (60/s accel, cap 9 m/s ≈ 18 blocks/3s), drains fuel; server clamps jetburn (reduce-only, anti-cheat); HUD fuel line; escapes any pit (anti-grief)
- [x] DYNAMITE GATE: buy + placement require rank>=1 (one promotion); shop row hidden below rank; server refuses both buy and detonate
- [x] RIG-FOLLOW: on owner join, hired rigs summonRig() to within ~10 blocks; rigAct leash snaps them back if they drift >40 blocks from an online owner
- [x] Wire-verified: safe spawn y, rank-0 dynamite refused, jetpack buy + 18s fuel + burn/clamp/persist, rig relocated to 5 blocks; climb 18.3 blocks/3s

## Round 51 (jetpack fuel fix + upgrades, headlamp, dynamite-shown)
- [x] Jetpack fuel now SERVER-AUTHORITATIVE: jetStart/jetStop wall-clock deducts real flight seconds (client can't under-report to fly free); mid-flight disconnect settles fuel; client adopts authoritative 'jetfuel'
- [x] Jetpack tank upgrade: MK-I..IV caps 9/18/27/36s ($2,500/tier); fuel cans fill to cap
- [x] HEADLAMP: $600, rank>=1 gated (hidden below), camera-follow PointLight toggled with L; battery seconds, server-authoritative headOn/headOff drain; battery $60/+1min, upgrade $1,500 (caps 1/5/15/30/60 min); HUD line
- [x] Dynamite shown-when-unqualified: locked chip 🔒 + corporate quip ("demolition is a privilege — earn one promotion")
- [x] Wire-verified: rank-0 headlamp refused, jetfuel clamps to tank cap, tank upgrade raises cap, headlamp buy/battery/drain; screenshot confirms headlamp lights the dark

## Round 52 (fix disappearing players)
- [x] ROOT CAUSE: presence depended on the observed player's client emitting a 2s move-heartbeat, which pauses when their tab backgrounds/phone locks/network hiccups → 15s client prune deleted still-present players; pos for a pruned id was ignored (no reappear until sector cross)
- [x] FIX: server presence heartbeat re-advertises every connected player's pos to their 3×3 neighborhood every 4s (server clock, interest-scoped); client prune 15s→20s; unknown-id pos → throttled resyncPlayers → server resends 3×3 pjoin roster
- [x] Wire-verified: a fully-silent player still receives 4 pos-heartbeats to observers over 14s (previously 0 → pruned)

## Round 53 (richer personnel file, store cleanup, player gear sprites)
- [x] Per-player CAREER LEDGER (prof.tally): snacksEaten, lampSeconds, jetFuelBurnt, flaresFired, dynArmed, blocksBlasted, gravesRobbed, torches/ladders/signs/crates placed, insuranceBought — tracked at each handler, rendered on /report
- [x] Store restructured: DIG TOOLS / SITE KIT categories always visible; EXECUTIVE CATALOG toggle (progressive disclosure) hides big-ticket gear (headlamp, jetpack, crate, insurance, store outpost, rig) until expanded
- [x] Player gear sprites: server broadcasts fx bitmask (1=jetFlying, 2=headOn) in pos; other players show a jetpack+flame while flying, a headlamp glow when lit, and an arm-raise when firing a flare
- [x] Verified: career ledger renders; shop categories + collapse screenshot; single-page jetpack flight (13 blocks, jetActive); pure-protocol watcher observes fx=3 (jet|lamp); headlamp glow visible cross-client

## Round 54 (rank perks: nameplate, drill, watcher)
- [x] FOREMAN nameplate ($2,000, rank>=3): prof.plate + plateHue; cyclePlate reroll (free, broadcast); name-tag recolours for everyone; survives death (earned identity)
- [x] SITE MANAGER drill ($5,000, rank>=4): buildShovel(tier,drill) industrial-auger viewmodel (amber body, black grip, grey fluted spinning bit) + jab dig animation; other players see a drill hand-tool; survives death
- [x] DIRECTOR OF DESCENT watcher (rank>=5, client-personal): solid-black humanoid + amber eyes trails ~9 blocks, always faces you; toast on first spawn
- [x] VP OF REMOVAL (rank>=6): E addresses watcher → random of 6 deadpan lines as a speech bubble; proximity prompt
- [x] CRITICAL FIX: buildShovel(1) runs at module load before `const me` → made drill a param (was TDZ crash on me.drill)
- [x] Wire-verified: rank gating (under-rank refused), cyclePlate changes hue, drill buy, all perks survive death; drill + watcher screenshots approved by user

## Round 55 (equippable lamp, refresh-restore, visible lamps, gear rebalance)
- [x] HEADLAMP equippable: added to hotbar ITEMS registry as an equip item (🔦, E toggles, L still works); slot shows ON/OFF and glows warm when lit (.slot.on)
- [x] REFRESH EXPLOIT FIX: server persists last pos on every accepted move (prof.lx/ly/lz/lry); blank rejoin resumes on the exact block (even mid-shaft) — a refresh is no longer a free ride to the surface. Explicit world code still overrides (join a friend's site). Death clears it (profile rebuilt) → surface respawn.
- [x] OTHER-PLAYER HEADLAMP VISIBLE: instant broadcastFx() on headOn/headOff (+jetStart/Stop) instead of waiting for the 4s heartbeat; headglow rebuilt as a soft radial-texture halo+core (additive, fog:false) — reads clearly as a lamp day or night
- [x] STORE: "BIGGER BATTERY/TANK" buttons → clean "UPGRADE"; headlamp gated EXCAVATOR (rank>=2), jetpack (rarer) FOREMAN (rank>=3) — MOBILITY category hidden until you qualify
- [x] HEADLAMP brightness scales with tier: intensity 2.4→7.2 (1x→3x at MK-V), reach 34→52 blocks
- [x] JETPACK rebalanced: JET_CAP [6,14,22,30] (was [9,18,27,36]), JETFUEL_PER_CAN 6 (= one starter tank); FUEL +6s
- [x] Wire-verified: rank gates (DIGGER refused both, EXCAVATOR lamp-only, FOREMAN both + tank T2→T4 then max), refresh restore Δ0/0/0 + explicit-code override, other sees lamp:true fx:2; screenshots: store UPGRADE, hotbar 🔦 OFF→ON, soft round lamp glow at night
- [ ] DEPLOY v45 / hole-v33 (pending user go-ahead)

## Round 56 (drill as equipment + bits, artifact-lore, rig gate, test cheats)
- [x] DRILL is now equippable (hotbar 🪛, toggle ON/OFF like headlamp via E; OFF = shovel). ON = drill viewmodel + ~6× dig power + faster jab cadence (0.14s vs 0.34s)
- [x] DRILL gate: SITE MANAGER (rank>=4) AND max shovel tier (MK-V). Server + client both enforce; client shows "NEEDS MK-V" until shovel maxed
- [x] DRILLBITS (consumable, tiered like jetpack tank+fuel): bitTier = durability cap [IRON 60s, CARBIDE 15min, DIAMOND 120min, OBSIDIAN 999min]; bitLife drains ONLY while drilling (server-authoritative drillStart/drillStop wall-clock, mirrors jet/headlamp; disconnect settles). Snaps at 0 → drill auto-off. 'bit' = fresh full bit (BIT_REFILL_PRICE), 'bitup' = next tier fresh (BIT_UP_PRICE)
- [x] Drill+bitTier survive death (earned); bitLife resets to 0 (consumable). Profile defaults + doDeath + bought payload + init mapping all carry bitTier/bitLife
- [x] ARTIFACT (block 17) now grants progressive lore in addition to $2,000: grantLore() reveals the next UNSEEN entry, never a dupe; memos (block 21) also skip already-read (use their slate id only if still new). All-collected → quiet 'loreNone' toast instead of a repeat
- [x] RIGS gated to SITE MANAGER (rank>=4) on server (hire) + client (offer hidden below rank4)
- [x] TEST-ONLY CHEATS behind HOLE_CHEATS=1 env (NEVER in Dockerfile/fly.toml/npm start). ws {t:'cheat',cmd,n}: money/rank/shovel/pack/bit/max. Client hooks HOLE.cheat(cmd,n) + HOLE.max(). Server ignores entirely without the flag (verified). cheatState msg → client adopts full profile
- [x] Verified: grantLore unit test (order, skip-seen, no-dupe-when-complete); wire (smlow drill refused / sm drill+bit-full-refused+drain 58.8s+bitup T2 900s / fore rig refused / sm rig hired / cheat max → jobsDone60 drill bitTier4 shovel5 $1e9); cheats OFF without flag; puppeteer (hotbar 🪛 OFF→ON, drill viewmodel on toggle, HUD "DRILL ON · DIAMOND BIT 120m 0s")
- [ ] DEPLOY v46 / hole-v34 (bundles rounds 54-56; pending user go-ahead)

## Round 57 (watcher physics, drill polish, dig lag, watcher speech, T legend)
- [x] WATCHER obeys game physics: gravity (24, same as player) + walks the terrain surface via groundFeetY(); no more floating to eye level. Walk animation (leg/arm swing while moving). Only ground-follows where chunks are loaded (else it'd snap to "solid" unloaded chunks). Verified wy==feet on flat ground; walk-in stops at 9 blocks
- [x] DRILL animation reworked: steady forward THRUST (drillPush lerp) + very fast bit spin (95 rad/s under load, 8 idle) while boring; removed the chop/jab (push=0.2*sin swing). Faint chatter vibration
- [x] DIG LAG fixed: breakBlock() was calling the FULL updateHud() (rebuilds hotbar DOM + all gear lines) on EVERY block — brutal at drill speed. Split out updateCounters() (pack/dug/drill-life only) for the hot path; full updateHud reserved for gear/inventory changes
- [x] WATCHER speech no longer overlaps: 5s interaction cooldown (spam-E is a no-op) + clearWatcherBubble() ensures only one bubble ever exists. Verified: 4× rapid address → single clean bubble
- [x] "T EMOTE" added to the on-screen controls legend (T was already bound; handbook already documented it)
- [x] Debug hooks: HOLE.watcher() {wy,feet,myY,dist}, HOLE.address()

## Round 58 (drill feel/crash, tier-coloured bits, brighter max lamp)
- [x] CRITICAL: fixed drill "locks the game / nothing happens / can't move" — tickDrill() referenced tick()'s local `uiOpen` → per-frame ReferenceError aborted the whole tick while holding click. Now passed as a param. Verified 0 pageerrors + movement works mid-drill
- [x] Drill animation: hold → thrusts FORWARD + bit revs up (spin lerps to 105) and drills; release → retracts + spins down to a full STOP. Removed the chop/jab
- [x] Drill power 6×→8× (one-bite breaks); ~7/s cadence (under the 8/s server budget)
- [x] Tier-coloured drill bits for rank feedback: IRON steel-grey, CARBIDE gunmetal, DIAMOND icy-cyan, OBSIDIAN purple-black. buildShovel guard now includes builtBitTier; me.bitTier read only when wantDrill (avoids the module-load TDZ)
- [x] MAX HEADLAMP much brighter: intensity 20→66 across tiers (torches are 36), reach 34→78, decay 1.3→1.05. No longer "only lights adjacent blocks"
- [x] Trimmed particle bursts while drilling (impact 3→1, break 8→4) to cut overhead
- [x] Debug hooks: HOLE.drill() toggle, HOLE.drillinfo()
