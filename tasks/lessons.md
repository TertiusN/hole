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

## Presence heartbeat (round 52)
- Other-player visibility must NOT depend on the observed player's client staying awake. Client move-heartbeats pause in backgrounded tabs → the 15s client prune deleted still-present players. Fix: server re-advertises every connected player's last pos to their 3×3 every 4s (broadcastNear), independent of that player's client. Client prune raised to 20s; pos for an unknown id triggers a throttled resyncPlayers request.
