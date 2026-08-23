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
