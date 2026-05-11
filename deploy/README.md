# Self-hosted production deploy

One-VPS deploy via docker-compose. Suitable for early-stage / MVP. Move to
ECS / App Runner once you cross ~1k concurrent users.

## What this stack runs
- **mongodb** (rs0 replica set, needed for Mongoose transactions)
- **redis** (rate-limit shared state, future caching)
- **seed** (one-shot — runs `seedProd.js` on first up, then exits)
- **backend** (Node.js API + WebSocket, port 5000 internal)
- **nginx** (TLS termination + reverse proxy + serves SPAs)

`backend` depends on `seed.completed_successfully` so the DB is always
seeded before the API accepts traffic.

## One-time host setup

```bash
# On the VPS (Ubuntu 22.04 / 24.04):
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable --now docker

# Clone your repo to the host
git clone https://github.com/you/trading-platform.git
cd trading-platform

# Build the frontends BEFORE bringing the stack up — nginx mounts their
# dist/ directories as static assets.
(cd client && npm ci && npm run build)
(cd admin  && npm ci && npm run build)

# Production env
cp deploy/.env.production.example deploy/.env.production
# → Edit deploy/.env.production: fill JWT secrets, Razorpay keys, etc.

# TLS certs — easiest path: Cloudflare Origin Cert (15-year, free)
mkdir -p deploy/certs
# Paste fullchain.pem + privkey.pem into deploy/certs/
# OR use Let's Encrypt via certbot — separate setup.

# Boot the stack
docker compose -f deploy/docker-compose.production.yml up -d --build
```

## What happens on `docker compose up`

```
mongodb  → starts, healthcheck initialises rs0
seed     → waits for mongodb healthy → runs seedProd.js → exits 0
backend  → waits for seed completed_successfully → starts API + WS
nginx    → starts, routes to backend + serves SPAs
```

Seed is **idempotent** — running `docker compose up` again on an existing
DB won't duplicate instruments. Safe to re-run.

## Verify

```bash
# All services up?
docker compose -f deploy/docker-compose.production.yml ps

# Seed output (should show "✓ Instruments: 15 created, 0 already present"
# on first run, all "already present" on subsequent runs)
docker logs tp-seed

# Backend up?
docker logs tp-backend | tail -20
curl -k https://api.yourdomain.com/api/health
```

## Create first admin

```bash
# After signing up as your real email through https://app.yourdomain.com:
docker exec -it tp-mongo mongosh trading_platform --eval '
  db.users.updateOne(
    { email: "you@yourdomain.com" },
    { $set: {
        role: "SUPER_ADMIN",
        isActive: true,
        kycStatus: "APPROVED",
        isEmailVerified: true
      }
    }
  )
'

# Then login → admin.yourdomain.com → Profile → enable 2FA IMMEDIATELY.
# (Production sets ADMIN_REQUIRE_2FA=true — otherwise you're locked out
# on next login.)
```

## Re-deploy after code change

```bash
git pull
(cd client && npm run build)
(cd admin  && npm run build)
docker compose -f deploy/docker-compose.production.yml up -d --build backend
```

Seed re-runs automatically (idempotent — only adds new instruments if any).
Nginx auto-reloads SPA bundles from the bind-mounted `dist/` dirs.

## Backup

```bash
# Daily mongodump (run via cron)
docker exec tp-mongo mongodump --archive=/data/db/backup-$(date +%F).gz --gzip
# Copy off-host via scp / rclone to S3 / Backblaze.
```
