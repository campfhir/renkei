# Deployment Guide

This guide covers deploying the Jira MCP Gateway to production.

## Prerequisites

- Node.js 18+ (recommended: 20.x)
- PostgreSQL 12+
- Atlassian OAuth app (for authentication)
- OIDC provider (Atlassian, Auth0, Okta, etc.)
- TLS certificate (HTTPS required for OAuth)

## Environment Setup

Create a `.env.local` file with production values:

```bash
# OAuth / OIDC Configuration
ATLASSIAN_CLIENT_ID=<your-client-id>
ATLASSIAN_CLIENT_SECRET=<your-client-secret>
ATLASSIAN_REDIRECT_URI=https://yourdomain.com/api/oauth/callback

# Encryption
# Generate with: openssl rand -base64 32
TOKEN_ENCRYPTION_KEY=<32-byte-base64-key>

# Database
DATABASE_URL=postgresql://user:password@postgres.example.com:5432/jira_mcp_db

# Server
PUBLIC_BASE_URL=https://yourdomain.com
NODE_ENV=production
```

### Generating Encryption Key

```bash
openssl rand -base64 32
# Output: zAq/TjlJxVVBkYO9H/NNfaJtfxhuQIXG69BfIWWX9ao=
```

## Database Setup

### Create PostgreSQL Database

```bash
createdb jira_mcp_db
createuser jira_mcp --createdb --pwprompt
psql jira_mcp_db -c "ALTER USER jira_mcp WITH PASSWORD '<secure-password>';"
```

### Run Migrations

Migrations are Kysely migrations under `lib/migrations`, applied in order and
recorded in the `kysely_migration` table. Never create these tables by hand:
the schema has changed several times — columns renamed, values re-encoded — and
a hand-built schema is not recorded in the ledger, so the migrations that would
bring it forward either re-run against tables that already exist or are skipped
on a table that is missing a column the code expects.

From a checkout:

```bash
pnpm tsx scripts/migrate.ts
```

From the published images, on a target machine:

```bash
docker compose -f docker-compose.yaml run --rm migrate
```

Run this **before** starting the gateway on every upgrade. The migrate service is
deliberately kept out of `docker compose up`, so starting the app never applies
migrations as a side effect — which means nothing applies them for you.

The app reports the mismatch rather than assuming it away. On startup it logs
every pending migration at error level, and `GET /api/health` answers 503 with
their names while any are outstanding:

```json
{
  "status": "degraded",
  "reason": "database schema is behind this build",
  "pendingMigrations": ["012-hash-client-secrets"],
  "action": "docker compose -f docker-compose.yaml run --rm migrate"
}
```

That is worth gating a deploy on. Skipping the step otherwise surfaces much
later and much further from the cause — a build expecting
`oauth_clients.client_secret_hash` against a database that still has
`client_secret` fails every MCP client registration with a 500, and the reason
appears only as a Postgres `42703 undefined_column` in the container log.

## Building for Production

```bash
# Install dependencies
pnpm install

# Build the application
npm run build

# Verify build
ls -la .next/
```

## Deployment Options

### Option 1: Vercel (Recommended)

Vercel is the easiest way to deploy Next.js:

```bash
npm install -g vercel

# Deploy
vercel --prod

# Set environment variables in Vercel UI or via CLI
vercel env add ATLASSIAN_CLIENT_ID
vercel env add ATLASSIAN_CLIENT_SECRET
vercel env add TOKEN_ENCRYPTION_KEY
vercel env add DATABASE_URL
vercel env add PUBLIC_BASE_URL
```

### Option 2: Self-Hosted on Linux/Docker

**Docker Setup:**

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
```

**Build and Run:**

```bash
docker build -t jira-mcp-gateway .

docker run \
  -e ATLASSIAN_CLIENT_ID="<value>" \
  -e ATLASSIAN_CLIENT_SECRET="<value>" \
  -e TOKEN_ENCRYPTION_KEY="<value>" \
  -e DATABASE_URL="postgresql://..." \
  -e PUBLIC_BASE_URL="https://yourdomain.com" \
  -p 3000:3000 \
  jira-mcp-gateway
```

**Docker Compose:**

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: jira_mcp
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: jira_mcp_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - '5432:5432'

  app:
    build: .
    environment:
      DATABASE_URL: postgresql://jira_mcp:${DB_PASSWORD}@postgres:5432/jira_mcp_db
      ATLASSIAN_CLIENT_ID: ${ATLASSIAN_CLIENT_ID}
      ATLASSIAN_CLIENT_SECRET: ${ATLASSIAN_CLIENT_SECRET}
      TOKEN_ENCRYPTION_KEY: ${TOKEN_ENCRYPTION_KEY}
      PUBLIC_BASE_URL: https://yourdomain.com
      NODE_ENV: production
    ports:
      - '3000:3000'
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### Option 3: Traditional Server (Ubuntu)

**Install Dependencies:**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib
```

**Setup Application:**

```bash
# Create app directory
sudo mkdir -p /opt/jira-mcp-gateway
sudo chown ubuntu:ubuntu /opt/jira-mcp-gateway
cd /opt/jira-mcp-gateway

# Clone repository
git clone <repo-url> .

# Install dependencies
pnpm install --frozen-lockfile

# Build
npm run build

# Create .env file
nano .env.local
```

**Systemd Service:**

```ini
# /etc/systemd/system/jira-mcp-gateway.service
[Unit]
Description=Jira MCP Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=app-user
WorkingDirectory=/opt/jira-mcp-gateway
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

# Environment variables
EnvironmentFile=/opt/jira-mcp-gateway/.env.local

[Install]
WantedBy=multi-user.target
```

**Start Service:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-mcp-gateway
sudo systemctl start jira-mcp-gateway
sudo systemctl status jira-mcp-gateway
```

## Nginx Reverse Proxy

```nginx
upstream jira_mcp {
  server 127.0.0.1:3000;
}

server {
  listen 80;
  server_name yourdomain.com;
  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl http2;
  server_name yourdomain.com;

  ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

  # SSL configuration
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  ssl_prefer_server_ciphers on;

  # Security headers
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Frame-Options DENY;
  add_header X-Content-Type-Options nosniff;

  location / {
    proxy_pass http://jira_mcp;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }
}
```

## SSL/TLS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot certonly --standalone -d yourdomain.com

# Auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

## Monitoring

### Health Check

```bash
curl https://yourdomain.com/api/health
# Expected: {"status":"ok"}
```

### Logs

View application logs:

```bash
# Systemd
sudo journalctl -u jira-mcp-gateway -f

# Docker
docker logs <container-id> -f
```

### Database Backups

```bash
# Daily backup script
#!/bin/bash
pg_dump -U jira_mcp jira_mcp_db | gzip > /backups/jira_mcp_$(date +%Y%m%d).sql.gz

# Keep last 30 days
find /backups -name "jira_mcp_*.sql.gz" -mtime +30 -delete
```

## Security Checklist

- [x] HTTPS enabled (TLS 1.2+)
- [x] Environment variables set (no secrets in code)
- [x] Database password strong (16+ characters, mixed case, symbols)
- [x] Regular database backups
- [x] PostgreSQL firewall rules (only app can connect)
- [x] Failed login attempts logged
- [x] Rate limiting configured (nginx or app-level)
- [x] Security headers configured (X-Frame-Options, etc.)
- [x] CORS configured properly
- [x] SQL injection prevention (using Kysely ORM)
- [x] CSRF protection (state verification in OAuth)
- [x] XSS protection (React escaping, no dangerouslySetInnerHTML)

## Troubleshooting

### Database Connection Failed

```bash
# Test connection
psql postgresql://user:pass@host:5432/db

# Check PostgreSQL is running
sudo systemctl status postgresql

# Verify firewall rules
sudo ufw status
```

### OAuth Redirect URI Mismatch

Error: "Redirect URI mismatch"

**Solution:** Ensure `PUBLIC_BASE_URL` matches OAuth app configuration exactly:

- App setting: `https://yourdomain.com`
- `ATLASSIAN_REDIRECT_URI`: `https://yourdomain.com/api/oauth/callback`
- `PUBLIC_BASE_URL`: `https://yourdomain.com`

### Token Encryption Errors

Error: "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key"

**Solution:** Regenerate the key:

```bash
openssl rand -base64 32
```

### High Memory Usage

If Node.js is using too much memory:

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=1024"

# Or in systemd service
EnvironmentFile=/opt/jira-mcp-gateway/.env.local
Environment="NODE_OPTIONS=--max-old-space-size=1024"
```

## Performance Optimization

### Database Connection Pooling

Already configured in `lib/db.ts` using node-postgres pool.

### Caching

Consider implementing:

- Redis for session caching
- CDN for static assets
- Jira API response caching (with TTL)

### Monitoring Query Performance

```sql
-- Enable query logging
SET log_statement = 'all';

-- View slow queries
SELECT * FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10;
```

## Version Upgrades

### Next.js Upgrades

```bash
npm update next
npm run build
npm start
```

### Node.js LTS Updates

- Current LTS: Node 20.x
- Next LTS: Node 22.x (April 2024)

Test thoroughly before upgrading production.

## Support

For issues:

1. Check logs: `journalctl -u jira-mcp-gateway -n 50`
2. Verify config: `echo $DATABASE_URL` (never commit .env files)
3. Test connectivity: `curl -v https://yourdomain.com/api/health`
4. Check database: `psql $DATABASE_URL -c "\dt"`
