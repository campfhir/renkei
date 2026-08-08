# ngrok Setup for Local Development

This guide explains how to use ngrok to test the application locally with OAuth callbacks and reverse proxy scenarios.

## Why ngrok?

ngrok creates a secure tunnel from your local machine to the internet. This is useful for:

- Testing OAuth 2.0/OIDC flows (which require public redirect URIs)
- Testing Azure AD authentication without deploying
- Testing reverse proxy header handling (X-Forwarded-*)
- Testing Atlassian OAuth callbacks

## Installation

### macOS (Homebrew)

```bash
brew install ngrok
```

### Other platforms

Download from https://ngrok.com/download

Verify installation:

```bash
ngrok --version
```

## Quick Start

### 1. Start ngrok tunnel

```bash
./scripts/ngrok-dev.sh
```

This will:

- Start ngrok on port 3000
- Extract the public URL (e.g., `https://xxxx-xxx-xxxx-xx.ngrok.io`)
- Create `.env.ngrok` with the URL
- Show next steps

### 2. Update OIDC Provider (Azure AD)

In Azure AD app registration settings, update:

- **Redirect URIs**: `https://<your-ngrok-url>/api/auth/oidc/callback`

Example:

```
https://1a2b-3c4d-5e6f-7g8h.ngrok.io/api/auth/oidc/callback
```

### 3. Update Atlassian OAuth

In Atlassian app settings, update:

- **Redirect URL**: `https://<your-ngrok-url>/api/oauth/callback`

Example:

```
https://1a2b-3c4d-5e6f-7g8h.ngrok.io/api/oauth/callback
```

### 4. Update environment variables

Either:

**Option A: Use `.env.local`** (recommended for testing)

```bash
PUBLIC_BASE_URL=https://1a2b-3c4d-5e6f-7g8h.ngrok.io
```

**Option B: Use ngrok subdomain** (requires paid plan)

```bash
ngrok http 3000 --subdomain=your-project-name
# URL will always be: https://your-project-name.ngrok.io
```

### 5. Start the application

```bash
pnpm dev
# or with Docker:
docker-compose -f docker-compose.yml up --build
```

### 6. Test the flow

Open your browser:

```
https://1a2b-3c4d-5e6f-7g8h.ngrok.io
```

## ngrok Dashboard

Monitor requests and headers in real-time:

```
http://127.0.0.1:4040
```

This is helpful for debugging:

- OIDC authorization requests
- OAuth redirect URIs
- X-Forwarded-* headers from ngrok
- Response status codes

## How ngrok Headers Work

ngrok automatically adds X-Forwarded-* headers:

```
X-Forwarded-For: 198.18.0.1      # ngrok server IP
X-Forwarded-Proto: https
X-Forwarded-Host: 1a2b-3c4d-5e6f-7g8h.ngrok.io
```

These are trusted unconditionally — the app assumes it always stands behind a
reverse proxy the operator controls. Locally, the ngrok agent forwards to
127.0.0.1, so nothing else is talking to that port.

## Testing Reverse Proxy Scenarios

To verify reverse proxy header handling works:

1. **Check home-realm redirect** (should use ngrok URL):

   ```bash
   curl -v "https://1a2b-3c4d-5e6f-7g8h.ngrok.io/api/home-realm?email=user@example.com"
   # Follow Location header → should show ngrok URL, not localhost:3000
   ```

2. **Check OIDC callback** (uses getOrigin):

   ```bash
   # After auth, Location header should be:
   # https://1a2b-3c4d-5e6f-7g8h.ngrok.io/mcp/{tenantId}
   ```

3. **Monitor headers in ngrok dashboard**:
   ```
   http://127.0.0.1:4040
   ```

## Multiple ngrok Instances

If you need multiple tunnels (rare):

```bash
ngrok http 3000 --region=us  # US
ngrok http 3000 --region=eu  # EU (in different terminal)
```

## Troubleshooting

### ngrok command not found

```bash
# Install ngrok first
brew install ngrok
```

### Port 3000 already in use

```bash
# Find and kill the process
lsof -i :3000
kill -9 <PID>
```

### OAuth callback fails

1. Verify the callback URL in the provider matches your ngrok URL
2. Check ngrok dashboard for the actual request/headers
3. Ensure `PUBLIC_BASE_URL` is set correctly in `.env.local`

### X-Forwarded headers not being used

1. Check that app is behind ngrok (not direct connection) — the headers are
   only present when a proxy adds them
2. Inspect the actual headers in the ngrok dashboard (http://127.0.0.1:4040)

### ngrok tunnel keeps dropping

- Check your internet connection
- Upgrade ngrok: `brew upgrade ngrok`
- Use regional server: `ngrok http 3000 --region=us`

## Useful ngrok Commands

```bash
# Start with custom region
ngrok http 3000 --region=eu

# Start with custom subdomain (paid plan only)
ngrok http 3000 --subdomain=my-project

# Inspect traffic in real-time
ngrok http 3000 --log=stdout

# Verbose logging
ngrok http 3000 -v

# View running tunnels
curl http://127.0.0.1:4040/api/tunnels | jq

# Kill ngrok
pkill -f "ngrok http"
```

## Security Notes

- ngrok URLs are public — anyone can access your localhost if they know the URL
- Use `--basic-auth=user:pass` for basic protection
- For production testing, use private ngrok endpoints
- Never commit .env.ngrok to git (add to .gitignore)

Example with basic auth:

```bash
ngrok http 3000 --basic-auth="user:password"
```
