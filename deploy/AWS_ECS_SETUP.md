# AWS ECS Deployment — First-Time Setup

One-time AWS infra setup. After this, every `git push main` auto-deploys
via `.github/workflows/deploy-aws.yml`.

## What you'll create

| Service | Purpose |
|---|---|
| **ECR repo** `trading-backend` | Container registry for backend image |
| **VPC + 2 public subnets** | Network for ECS tasks (Copilot creates) |
| **ECS Cluster** `trading-platform-prod` | Fargate cluster |
| **Task Definition** `trading-backend-task` | Container spec — image, CPU, memory, env, secrets |
| **ECS Service** `trading-backend-svc` | Desired-count + auto-restart |
| **ALB** (Application Load Balancer) | HTTPS termination, routes to ECS tasks |
| **Secrets Manager** secret `trading-platform/prod/env` | All sensitive env vars |
| **2 S3 buckets** | `yourdomain-client`, `yourdomain-admin` |
| **2 CloudFront distributions** | Edge cache + custom domains for SPAs |
| **Route 53 / CloudFlare DNS** | Maps api/app/admin to ALB + CloudFront |

## Path A — AWS Copilot CLI (recommended, takes ~15 min)

Copilot is AWS's own tool that creates VPC + ALB + ECS + Task Def + Service
from a single manifest. Saves 2+ hours vs the Console.

### 1. Install Copilot

```bash
# macOS / Linux
curl -Lo copilot https://github.com/aws/copilot-cli/releases/latest/download/copilot-darwin
chmod +x copilot && sudo mv copilot /usr/local/bin/

# Windows (PowerShell)
Invoke-WebRequest -Uri https://github.com/aws/copilot-cli/releases/latest/download/copilot-windows.exe -OutFile $env:USERPROFILE\copilot.exe
# Add $env:USERPROFILE to PATH
```

### 2. AWS CLI configure

```bash
aws configure
# Access Key ID:     <from IAM user>
# Secret Access Key: <from IAM user>
# Region:            ap-south-1   (Mumbai)
# Output format:     json
```

### 3. Create the Secrets Manager secret first

```bash
aws secretsmanager create-secret \
  --name trading-platform/prod/env \
  --region ap-south-1 \
  --secret-string '{
    "MONGODB_URI": "mongodb+srv://USER:PASS@cluster.mongodb.net/trading_platform?retryWrites=true&w=majority",
    "JWT_ACCESS_SECRET": "<64 hex chars>",
    "JWT_REFRESH_SECRET": "<64 hex chars>",
    "RAZORPAY_KEY_ID": "rzp_live_...",
    "RAZORPAY_KEY_SECRET": "...",
    "RAZORPAY_WEBHOOK_SECRET": "...",
    "SENTRY_DSN": "https://...@sentry.io/...",
    "FINNHUB_API_KEY": "..."
  }'
```

Generate JWT secrets locally first:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"   # run twice
```

### 4. Init Copilot app

```bash
cd "trading-platform  last and"   # repo root
copilot app init trading-platform
copilot env init --name prod --region ap-south-1 --default-config
copilot env deploy --name prod
```

This creates VPC + 2 public subnets + ECS cluster.

### 5. Init the backend service

```bash
copilot svc init \
  --name backend \
  --svc-type "Load Balanced Web Service" \
  --dockerfile backend/Dockerfile \
  --port 5000
```

Now edit `copilot/backend/manifest.yml` — paste this:

```yaml
name: backend
type: Load Balanced Web Service

image:
  build:
    dockerfile: backend/Dockerfile
    context: backend
  port: 5000

http:
  path: '/'
  healthcheck:
    path: '/api/ready'
    healthy_threshold: 2
    unhealthy_threshold: 3
    interval: 10s
    timeout: 5s
    grace_period: 60s

cpu: 1024     # 1 vCPU
memory: 2048  # 2 GB
count:
  range: 1-3
  cpu_percentage: 70
exec: true    # allow `copilot svc exec` for debugging

variables:
  NODE_ENV: production
  PORT: 5000
  ADMIN_REQUIRE_2FA: 'true'
  KYC_REQUIRED: 'true'
  PROMETHEUS_ENABLED: 'true'
  RATE_LIMIT_ORDERS_PER_MIN: '60'
  CORS_ORIGINS: 'https://app.yourdomain.com,https://admin.yourdomain.com'

secrets:
  MONGODB_URI:
    secretsmanager: 'trading-platform/prod/env:MONGODB_URI::'
  JWT_ACCESS_SECRET:
    secretsmanager: 'trading-platform/prod/env:JWT_ACCESS_SECRET::'
  JWT_REFRESH_SECRET:
    secretsmanager: 'trading-platform/prod/env:JWT_REFRESH_SECRET::'
  RAZORPAY_KEY_ID:
    secretsmanager: 'trading-platform/prod/env:RAZORPAY_KEY_ID::'
  RAZORPAY_KEY_SECRET:
    secretsmanager: 'trading-platform/prod/env:RAZORPAY_KEY_SECRET::'
  RAZORPAY_WEBHOOK_SECRET:
    secretsmanager: 'trading-platform/prod/env:RAZORPAY_WEBHOOK_SECRET::'
  SENTRY_DSN:
    secretsmanager: 'trading-platform/prod/env:SENTRY_DSN::'
  FINNHUB_API_KEY:
    secretsmanager: 'trading-platform/prod/env:FINNHUB_API_KEY::'

logging:
  retention: 30
```

### 6. Deploy

```bash
copilot svc deploy --name backend --env prod
```

5-10 min. Output:
```
Service backend deployed:
  https://trading-platform-prod-Public-XXXXXX.ap-south-1.elb.amazonaws.com
```

### 7. Seed the database (one-time)

Trigger the GitHub Actions seed job (see deploy-aws.yml):
- Go to GitHub repo → Actions → "Deploy to AWS" → Run workflow → check "Run production seed" → Run.

OR run the ECS one-shot task manually:
```bash
aws ecs run-task \
  --cluster trading-platform-prod \
  --task-definition trading-backend-task \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"backend","command":["node","src/utils/seedProd.js"]}]}'
```

Get cluster/subnet/SG IDs from:
```bash
aws ecs describe-services --cluster trading-platform-prod --services backend \
  --query 'services[0].{network:networkConfiguration,task:taskDefinition}'
```

### 8. Create your admin user

Sign up via the client app, then promote yourself:
```bash
# Connect to Atlas from your laptop (whitelist your IP temporarily)
mongosh '<your Atlas URI>'
> db.users.updateOne(
    { email: 'you@yourdomain.com' },
    { $set: { role: 'SUPER_ADMIN', isActive: true, kycStatus: 'APPROVED', isEmailVerified: true } }
  )
```

Login admin → **enable 2FA immediately** (production has `ADMIN_REQUIRE_2FA=true`).

## Path B — Console (ECS Express Mode)

If you want to click through the UI instead of CLI:

1. Console → **ECR** → Create repository `trading-backend`. Note the URI.
2. Build + push image locally (needs Docker installed):
   ```bash
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <ACCT>.dkr.ecr.ap-south-1.amazonaws.com
   cd backend
   docker build -t trading-backend .
   docker tag trading-backend:latest <ACCT>.dkr.ecr.ap-south-1.amazonaws.com/trading-backend:v1
   docker push <ACCT>.dkr.ecr.ap-south-1.amazonaws.com/trading-backend:v1
   ```
3. Console → **ECS** → Express Mode → paste image URI.
4. In the same form, scroll down to "Environment variables" — but Express
   Mode doesn't easily support Secrets Manager. Better to skip this and
   use Copilot or define a custom Task Definition.

**Express Mode is fine for a quick smoke test but NOT for production** —
secrets get baked into the task def as plaintext env vars instead of
runtime-resolved from Secrets Manager. Use Copilot (Path A) for prod.

## Frontends (S3 + CloudFront)

For each app (`client` and `admin`), repeat:

```bash
# Create bucket (region matches your CloudFront origin)
aws s3 mb s3://yourdomain-client --region ap-south-1

# Block public access — CloudFront uses Origin Access Identity instead
aws s3api put-public-access-block --bucket yourdomain-client --public-access-block-configuration '{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'

# Build + upload
cd client
echo "VITE_API_BASE=https://api.yourdomain.com" > .env.production
npm run build
aws s3 sync dist/ s3://yourdomain-client/ --delete

# CloudFront — easier via Console:
#   - Create distribution
#   - Origin: S3 bucket (with OAC — auto-creates bucket policy)
#   - Default root object: index.html
#   - Error response: 404 → /index.html status 200 (SPA routing)
#   - Alternate domain: app.yourdomain.com
#   - SSL: Request ACM cert IN us-east-1 (CloudFront requirement)
```

Note: ACM cert for the BACKEND ALB stays in ap-south-1. The CloudFront
cert must be in us-east-1. AWS quirk.

## DNS — Route 53 OR CloudFlare

**CloudFlare recommended** — free DDoS protection, easier WAF rules.

Records (add at CloudFlare or whichever DNS provider):
```
CNAME  api.yourdomain.com    → trading-platform-prod-Public-XXXX.ap-south-1.elb.amazonaws.com
CNAME  app.yourdomain.com    → dXXXXXXXXXXXXX.cloudfront.net
CNAME  admin.yourdomain.com  → dYYYYYYYYYYYYY.cloudfront.net
```

CloudFlare SSL/TLS → "Full (strict)".

## GitHub Secrets to set

In repo → Settings → Secrets and variables → Actions → New repository secret:

```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION                       ap-south-1
ECR_REPOSITORY                   trading-backend
ECS_CLUSTER                      trading-platform-prod
ECS_SERVICE                      backend
ECS_TASK_DEFINITION_FAMILY       trading-platform-prod-backend
ECS_SUBNETS                      subnet-xxx,subnet-yyy   (from `aws ec2 describe-subnets`)
ECS_SECURITY_GROUP               sg-xxx                  (Copilot creates one named *-PublicLoadBalancerSecurityGroup)
S3_CLIENT_BUCKET                 yourdomain-client
S3_ADMIN_BUCKET                  yourdomain-admin
CF_CLIENT_DIST_ID                EXXXXXXXXX
CF_ADMIN_DIST_ID                 EYYYYYYYYY
VITE_API_BASE                    https://api.yourdomain.com
MONGODB_URI                      mongodb+srv://...        (for seed job only — also lives in Secrets Manager for ECS)
FINNHUB_API_KEY                  d7ushapr...              (optional)
```

## Verify deploy

```bash
# After first git push:
curl https://api.yourdomain.com/api/health
# {"status":"ok",...}

curl https://api.yourdomain.com/api/ready
# {"status":"ready",...}  (means ECS task is healthy + Atlas connected)

# CloudFront should serve SPAs:
curl -I https://app.yourdomain.com
# HTTP/2 200, X-Cache: Hit from cloudfront (after first request)
```

## Cost (Mumbai, ~1k DAU)

| | Cost |
|---|---|
| ECS Fargate (1 vCPU, 2GB always-on) | ~$32 |
| ALB | ~$22 |
| Atlas M10 | $57 |
| S3 + CloudFront (2 SPAs, light) | ~$8 |
| Route 53 zone | $0.50 |
| Secrets Manager (10 secrets) | ~$4 |
| CloudWatch logs (5GB) | ~$10 |
| NAT Gateway egress + data transfer | ~$15 |
| **Total** | **~$150/mo** |

Cheaper alternative: replace ALB with API Gateway HTTP API (saves ~$15)
or run on a single ECS task without ALB during MVP (lose zero-downtime
deploys). Not recommended for production.

## When to scale

- ECS task CPU > 70% sustained → bump count or CPU
- WebSocket connections > 5k → add Redis for shared pub-sub, scale to 3+ tasks
- ALB 5xx > 1% → check CloudWatch logs, increase healthcheck grace
- Atlas M10 CPU > 70% → migrate to M20 ($150)
