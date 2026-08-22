# Deploying HOLE to fly.io

One stateful Node process + one 1 GB volume. Everything is already configured
in `fly.toml` / `Dockerfile`. Expected bill: **~$5–8/month** (shared-cpu-1x
1 GB + volume + traffic), charged monthly to the card on file.

## One-time setup (~15 minutes)

```bash
# 1. install the CLI and sign up (this is where the credit card goes)
brew install flyctl
fly auth signup            # or: fly auth login

# 2. edit fly.toml first if you want:
#    - app name  ("hole-planet" must be globally unique)
#    - region    (ams = Amsterdam, jnb = Johannesburg, lhr = London, iad = US east)

# 3. create the app and its disk, then ship it (run from this folder)
fly apps create hole-planet
fly volumes create hole_data --size 1 --region ams   # match primary_region!
fly deploy

# 4. done — the planet is live
fly open                   # opens https://hole-planet.fly.dev
```

The `.fly.dev` URL already has TLS, so the PWA install and wss:// work
immediately. No other services needed.

## Custom domain (optional)

```bash
fly certs add hole.yourdomain.com
# then add the DNS records it prints (A + AAAA, or a CNAME to hole-planet.fly.dev)
fly certs show hole.yourdomain.com   # wait for "Ready"
```

## Rules of operation

- **Never scale beyond 1 machine.** `fly scale count 1` is the only valid
  count — two machines would be two separate planets with two separate
  volumes. All scaling is vertical: `fly scale memory 2048` if it ever
  needs it (it won't for a long time).
- Deploys (`fly deploy`) send SIGTERM → the server flushes every dirty
  chunk + meta.json before the new version boots (`kill_timeout = 30s`
  covers it). ~10–20 s downtime per deploy; players reconnect on refresh.
- If the machine crashes, fly restarts it automatically and the world
  reloads from the volume.

## Monitoring & analytics

- `https://<app>.fly.dev/stats` — the Company Report: gameplay ledger,
  countries, page views / traffic ("FRONT OFFICE" section), uptime.
- `https://<app>.fly.dev/health` — JSON heartbeat (good for uptime pingers
  like UptimeRobot's free tier, if you want an email when it's down).
- `fly logs` — live server logs; `fly status` — machine state.
- Fly dashboard has per-machine CPU/RAM/bandwidth graphs built in.

## Backups

Fly snapshots the volume automatically **daily, retained 5 days**
(`fly volumes snapshots list <volume-id>`). The world is tiny, so for
belt-and-braces run this occasionally (or cron it on your laptop):

```bash
fly ssh console -C "tar czf /tmp/hole-backup.tgz -C /data ." \
  && fly ssh sftp get /tmp/hole-backup.tgz ./hole-backup-$(date +%F).tgz
```

Restoring = untar into `/data` (or seed a fresh volume from a snapshot).

## Costs recap

| item                    | ~cost/mo |
|-------------------------|----------|
| shared-cpu-1x, 1 GB RAM | $5–6     |
| 1 GB volume             | $0.15    |
| bandwidth (modest play) | ~$0–2    |

No other subscriptions: TLS is free (fly or Let's Encrypt), analytics are
self-hosted on `/stats`, geo lookup (ip-api.com) is free tier.
