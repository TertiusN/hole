# Lessons & Principles

## PRIME DIRECTIVE — preserve planet progress at all costs

The shared 999,000,000,000-block countdown is the game. HOLE is an incremental
game; the addiction is the common goal, and the promise is that every block
anyone removes is gone FOREVER. Breaking that promise — even once, even
briefly, even only visually — attacks the core hook.

Operational rules that follow from this:

1. **Never wipe or regenerate prod `data/`.** Not chunks, not `meta.json`
   (globalDug, leaderboard, profiles). Worldgen changes must be additive; if a
   change would invalidate existing chunks, accept the visual seams instead.
2. **The save path is sacred.** Async chunk saves every 10s + full
   `saveWorldSync()` on SIGTERM. Any deploy/config change must keep both
   working. `kill_timeout` in fly.toml exists to let the flush finish.
3. **Exactly one machine.** A second Fly instance = a second volume = a second
   planet = split progress. Multi-region only ever via site-range sharding
   with a shared global counter (see README "Scale").
4. **Test boot against populated data.** An empty test world hid a boot crash
   that took prod down when real data (a placed sign) hit the code path.
5. **Backup before anything risky:**
   `fly ssh console -C "tar czf /tmp/hole-backup.tgz -C /data ." && fly ssh sftp get /tmp/hole-backup.tgz`
   (plus Fly's automatic daily volume snapshots, 5-day retention).
6. **Perceived progress is progress.** Optimistic client digs must always
   reconcile with server truth (corrective sets on rejection). "My blocks came
   back" feels like theft even when no data was lost.

## Earlier lessons

- Kill test servers before ending a work session; the user runs `npm start`
  on 3013 (use PORT=3014 + isolated HOLE_DATA for tests).
- Browsers refuse pointer lock from an Escape keypress — use the wantRelock
  pattern, never fight the browser.
- Boot-time code that calls helpers must live BELOW the consts it needs
  (TDZ crashes twice now: name-policy scrub, sign filter).
- Element id collisions fail silently and weirdly (#help). Grep before naming.

## DoS hardening (round 45)
- WebSocketServer `maxPayload: 65536`; per-connection msg token bucket (20/s, 40 burst) → drop over budget, kick sustained floods; per-IP cap 24.
- CRITICAL: `maxPayload` overflow emits 'error' on the individual socket — MUST have `ws.on('error', () => {})` per connection or the whole process crashes (the protection was briefly a crash vector). `wss.on('error')` does NOT cover per-socket errors.

## Cargo persistence (round 48)
- Unsold cargo (me.svInv/svInvN) is TRANSIENT on the player object; it was never in the profile, so every deploy/restart rugged it. Fix: saveCargo(p) mirrors live pack → profile; called in saveWorld + saveWorldSync (deploy-safe) + ws.close + sell/death/dump; restored on join. This is a prime-directive fix — dug material must never vanish.

## Test-only cheats (round 56)
- Cheats are gated by `const CHEATS = process.env.HOLE_CHEATS === '1'` and the `{t:'cheat'}` handler returns immediately unless CHEATS. The flag is NOT in Dockerfile / fly.toml / `npm start`, so prod and the user's normal local run never expose it. Enable locally with `HOLE_CHEATS=1 npm start` (or the test harness's PORT=3014). Client hooks: `HOLE.cheat('max'|'money'|'rank'|'shovel'|'pack'|'bit', n)` and `HOLE.max()`. Verified the server drops cheat messages with the flag off.
- Consumable-that-drains-over-time pattern (jetpack fuel, headlamp battery, drill bit): server owns the clock via start/stop messages (jetStart/Stop, headOn/Off, drillStart/Stop) deducting real elapsed seconds; the client drains a local mirror for the HUD and reconciles on the authoritative reply; ALWAYS settle in the ws.close handler too or a mid-use disconnect banks free time.

## Wire-test gotchas (round 55)
- The client sends movement as `{t:'move',...}`; the server re-broadcasts it to OTHERS as `{t:'pos',...}`. A raw-ws test that sends `t:'pos'` is silently ignored (no handler) — always send `t:'move'` to drive server-side position.
- Join success is `{t:'init'}`, not `{t:'joined'}`. Trigger post-join actions on `init`.
- Text frames arrive as Buffers alongside binary chunk frames; guard with `d[0]===0x7b` (`{`) before JSON.parse, or the parse throws on binary.
- Seeded profiles with no `meta.auth` entry join fine on a blank token (first-claim). No claim code needed for tests.

## Refresh must not be an escape hatch (round 55)
- Getting trapped (dynamite pit, dug-in) and refreshing used to respawn you on the surface — a free escape. Fix: persist last pos (`prof.lx/ly/lz/lry`) on every accepted move; a blank-code rejoin resumes on the exact block. An explicit world code still overrides (so joining a friend's site works), and death clears it (profile rebuilt → surface). This is aligned with the jetpack being the *paid* escape, not a refresh.

## Presence heartbeat (round 52)
- Other-player visibility must NOT depend on the observed player's client staying awake. Client move-heartbeats pause in backgrounded tabs → the 15s client prune deleted still-present players. Fix: server re-advertises every connected player's last pos to their 3×3 every 4s (broadcastNear), independent of that player's client. Client prune raised to 20s; pos for an unknown id triggers a throttled resyncPlayers request.

## Helper functions extracted from tick() must receive tick-locals (round 58)
- BUG: tickDrill() referenced `uiOpen`, which is a `const` LOCAL inside tick(), not a global. Every frame the player held the drill (digging=true), `tickDrill` threw `ReferenceError: uiOpen is not defined` — and because it ran early in tick(), the exception aborted the REST of the frame (dig logic AND movement). Symptom: "long-click does nothing and locks the game, can't move." It only fired while digging because `drillOn && bitLife>0 && digging && ... && !uiOpen` short-circuits before `!uiOpen` when not digging.
- LESSON: when pulling logic out of the big tick() into its own function, PASS the tick-locals it needs (uiOpen, dt, now) as params — don't assume they're global. A parse check won't catch this (it's a runtime ReferenceError); a headless run that watches page.on('pageerror') does. Always wire a pageerror listener in puppeteer tests.
