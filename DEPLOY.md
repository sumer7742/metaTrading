# Manual EC2 Deployment — trading.metawebdevelopment.cloud

## Architecture

```
Internet  →  EC2 :80/:443  →  Host nginx (TLS)  →  Docker containers
                                                    ├─ tp-backend  127.0.0.1:5000
                                                    ├─ tp-client   127.0.0.1:8081
                                                    └─ tp-admin    127.0.0.1:8082

Single domain (Cloudflare/registrar A record → 35.154.225.175):
  trading.metawebdevelopment.cloud
    /api/*    → backend  (Node API)
    /ws       → backend  (WebSocket)
    /admin/*  → admin SPA
    /*        → client SPA
```

---

## 1. EC2 prep (one-time)

SSH into your Ubuntu EC2:

```bash
ssh -i ~/your-key.pem ubuntu@35.154.225.175

# Update
sudo apt update && sudo apt upgrade -y

# Docker + Compose plugin
sudo apt install -y docker.io docker-compose-v2 git nginx certbot python3-certbot-nginx
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# Log out + back in so the new group takes effect, then verify:
docker ps
```

Security group on EC2 → inbound: **22 (SSH)**, **80 (HTTP)**, **443 (HTTPS)**. Nothing else needs to be open — the three containers are bound to 127.0.0.1 only.

---

## 2. Clone repo

```bash
cd ~
git clone https://github.com/<you>/trading-platform.git
cd "trading-platform  last and"   # or whatever your folder name is
```

---

## 3. Backend env file

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

Set at minimum:
```
NODE_ENV=production
PORT=5000

# Atlas connection string
MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/trading_platform?retryWrites=true&w=majority

# Generate fresh: openssl rand -hex 64
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...

# CORS — same-origin under path-based routing, so just the one host
CORS_ORIGINS=https://trading.metawebdevelopment.cloud

# HTTPS posture (host nginx terminates TLS, but containers see http internally — set true ONLY after certbot is done)
HTTPS_ENABLED=true
ADMIN_REQUIRE_2FA=true
KYC_REQUIRED=true

# Razorpay / Sentry / Finnhub / etc.
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
FINNHUB_API_KEY=...
SENTRY_DSN=
```

Save + exit.

---

## 4. Build + start containers

```bash
cd ~/trading-platform\ \ last\ and/   # adjust path
docker compose up -d --build
docker compose ps     # all three should say "Up"
docker compose logs -f backend
```

Backend logs should show `MongoDB connected` + `Server listening { port: 5000 }`. Ctrl-C to stop tailing.

---

## 5. Wire host nginx

```bash
# Copy the single vhost into nginx's sites-available
sudo cp nginx/trading.metawebdevelopment.cloud.conf \
        /etc/nginx/sites-available/trading.metawebdevelopment.cloud

# Enable
sudo ln -sf /etc/nginx/sites-available/trading.metawebdevelopment.cloud \
            /etc/nginx/sites-enabled/

# Drop the default catch-all (causes hostname-matching conflicts)
sudo rm -f /etc/nginx/sites-enabled/default

# Test + reload
sudo nginx -t
sudo systemctl reload nginx
```

Smoke test — HTTP (before SSL):
```bash
curl -H 'Host: trading.metawebdevelopment.cloud' http://localhost/api/health
# {"status":"ok",...}

curl -I -H 'Host: trading.metawebdevelopment.cloud' http://localhost/
# HTTP/1.1 200 OK (client SPA index)
```

If DNS is propagated, also test from your laptop:
```bash
curl http://trading.metawebdevelopment.cloud/api/health
curl http://trading.metawebdevelopment.cloud/
curl http://trading.metawebdevelopment.cloud/admin/
```

---

## 6. SSL via Certbot

```bash
sudo certbot --nginx \
  -d trading.metawebdevelopment.cloud \
  --redirect --agree-tos -m you@yourmail.com --no-eff-email
```

Certbot will:
1. Verify via HTTP-01 (uses port 80 — must be reachable from internet)
2. Get cert from Let's Encrypt
3. **Modify the nginx config in place** to add `listen 443 ssl` + redirect HTTP → HTTPS
4. Reload nginx

Auto-renewal is set up via systemd timer — verify:
```bash
sudo systemctl list-timers certbot
sudo certbot renew --dry-run
```

After certbot success, edit `backend/.env`:
```
HTTPS_ENABLED=true
```
Then restart the backend container so it serves HSTS + CSP correctly:
```bash
docker compose restart backend
```

---

## 7. Seed instruments + create admin user (one-time)

```bash
# Production-safe seed (instruments + plans + global routing setting)
docker compose exec backend node src/utils/seedProd.js

# Sign up a real account via https://trading.metawebdevelopment.cloud, then promote
# yourself to SUPER_ADMIN in Atlas (via mongosh on your laptop or Atlas Data Explorer):
db.users.updateOne(
  { email: 'you@yourmail.com' },
  { $set: { role: 'SUPER_ADMIN', isActive: true, kycStatus: 'APPROVED', isEmailVerified: true } }
)
```

Visit https://trading.metawebdevelopment.cloud/admin → login → Profile → **Enable 2FA immediately** (production has `ADMIN_REQUIRE_2FA=true`; otherwise next login is locked).

---

## 8. Re-deploy after code changes

Push to GitHub on your laptop. On EC2:

```bash
cd ~/trading-platform\ \ last\ and/
./deploy.sh
```

That script: `git pull` → `docker compose up -d --build` → prune dangling images. ~1 min for code-only change, ~3-5 min if `package.json` changed.

For just backend code change (faster):
```bash
git pull
docker compose up -d --build backend
```

---

## 9. Debug commands

```bash
# Status of all three containers
docker compose ps

# Live logs — single service
docker compose logs -f backend
docker compose logs -f client
docker compose logs -f admin

# Last 200 lines, all services
docker compose logs --tail=200

# Shell into a container
docker compose exec backend sh
docker compose exec client sh

# Restart one service
docker compose restart backend

# Stop everything
docker compose down

# Stop + remove volumes too (DESTROYS uploads — be careful)
docker compose down -v

# Verify host nginx config syntax
sudo nginx -t

# Live nginx access log
sudo tail -f /var/log/nginx/access.log

# Errors only
sudo tail -f /var/log/nginx/error.log

# Disk usage by Docker
docker system df

# Reclaim disk — removes stopped containers + dangling images + unused networks
docker system prune -f

# Aggressive cleanup — also removes UNUSED images (careful)
docker system prune -af

# Backend healthcheck from inside the box
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5000/api/ready

# WebSocket smoke (needs wscat: npm i -g wscat)
wscat -c wss://trading.metawebdevelopment.cloud/ws
```

---

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `connect ECONNREFUSED 127.0.0.1:27017` in backend logs | `MONGODB_URI` still points at localhost | Edit `backend/.env` to Atlas URI; `docker compose restart backend` |
| Browser 404 on `/trade` refresh | SPA fallback missing | Verify container nginx config has `try_files $uri /index.html;` — should already be in place |
| CORS error in browser console | `CORS_ORIGINS` missing your domain | Add exact `https://trading.metawebdevelopment.cloud` to `backend/.env`, restart |
| Admin assets 404 under /admin/ | `VITE_BASE` not `/admin/` at build time | Rebuild admin image with `--build-arg VITE_BASE=/admin/` |
| Certbot fails: "No A record" | DNS not propagated yet | Wait 5-15 min, verify with `dig trading.metawebdevelopment.cloud +short` returning 35.154.225.175 |
| WebSocket fails after SSL | `wss://` URL wrong / nginx /ws block missing | Verify nginx config has the WS `Upgrade` headers in the /ws location |
| Razorpay webhook fails signature | Wrong `RAZORPAY_WEBHOOK_SECRET` | Copy from Razorpay dashboard → Webhooks → reveal secret |
| Admin login 403 with ADMIN_2FA_REQUIRED | Admin hasn't enabled 2FA | Temporarily set `ADMIN_REQUIRE_2FA=false` → login → enable 2FA → set back to true → restart |

---

## File map for this deploy

```
trading-platform/
├── deploy.sh                            ← one-line redeploy
├── docker-compose.yml                   ← 3 services, all bound to 127.0.0.1
├── backend/
│   ├── Dockerfile                       ← API only, port 5000
│   ├── .env                             ← (gitignored) prod secrets
│   └── src/server.js                    ← reads CORS_ORIGINS, HTTPS_ENABLED
├── client/
│   ├── Dockerfile                       ← vite build → nginx alpine
│   ├── nginx.conf                       ← in-container, SPA try_files
│   └── .env.example                     ← documented prod build args
├── admin/
│   ├── Dockerfile                       ← same as client (with VITE_BASE=/admin/)
│   ├── nginx.conf                       ← same SPA fallback
│   └── .env.example
└── nginx/                               ← host nginx config (single vhost)
    └── trading.metawebdevelopment.cloud.conf
```
