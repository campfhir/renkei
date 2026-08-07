#!/bin/bash

# Setup ngrok tunnel for local development
# Useful for testing OAuth callbacks and reverse proxy setups

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
  echo -e "${RED}✗ ngrok is not installed${NC}"
  echo ""
  echo "Install ngrok:"
  echo "  macOS (homebrew): brew install ngrok"
  echo "  Or download from: https://ngrok.com/download"
  exit 1
fi

# Check if jq is available for JSON parsing
HAS_JQ=true
if ! command -v jq &> /dev/null; then
  HAS_JQ=false
  echo -e "${YELLOW}⚠ jq not found - URL extraction may not work automatically${NC}"
fi

echo -e "${BLUE}Starting ngrok tunnel on port 3000...${NC}"
echo ""

# Kill any existing ngrok processes
pkill -f "ngrok http" || true
sleep 1

# Start ngrok in the background and capture output
NGROK_LOG=$(mktemp)
ngrok http 3000 --log=stdout > "$NGROK_LOG" 2>&1 &
NGROK_PID=$!

# Wait for ngrok to start
sleep 2

# Extract the ngrok URL
NGROK_URL=""
if [ "$HAS_JQ" = true ]; then
  # Try to get URL from ngrok API
  NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | jq -r '.tunnels[0].public_url' 2>/dev/null || echo "")
fi

# Fallback: extract from log file
if [ -z "$NGROK_URL" ]; then
  NGROK_URL=$(grep -i "started tunnel" "$NGROK_LOG" | grep -oE 'https://[a-z0-9-]+\.ngrok\.io' | head -1 || echo "")
fi

# If still not found, ask user to check manually
if [ -z "$NGROK_URL" ]; then
  echo -e "${YELLOW}Could not automatically extract ngrok URL${NC}"
  echo ""
  echo "ngrok is running in the background (PID: $NGROK_PID)"
  echo "Check the URL at: http://127.0.0.1:4040"
  echo ""
  read -p "Enter your ngrok URL (e.g., https://xxxx-xx-xxx-xxx-xx.ngrok.io): " NGROK_URL
fi

if [ -z "$NGROK_URL" ]; then
  echo -e "${RED}No ngrok URL provided${NC}"
  kill $NGROK_PID 2>/dev/null || true
  rm -f "$NGROK_LOG"
  exit 1
fi

# Clean up log file
rm -f "$NGROK_LOG"

echo -e "${GREEN}✓ ngrok tunnel started${NC}"
echo -e "${GREEN}Public URL: ${BLUE}${NGROK_URL}${NC}"
echo ""

# Create .env.ngrok file with necessary variables
ENV_FILE=".env.ngrok"
cat > "$ENV_FILE" << EOF
# ngrok tunnel for local development
PUBLIC_BASE_URL=$NGROK_URL
TRUSTED_PROXY_IPS=127.0.0.1,::1,172.17.0.1

# OIDC - Update with your actual credentials if needed
# PLATFORM_OIDC_CLIENT_ID=...
# PLATFORM_OIDC_CLIENT_SECRET=...
# PLATFORM_OIDC_DISCOVERY_ENDPOINT=...

# Atlassian OAuth
# Update ATLASSIAN_REDIRECT_URI to match your ngrok URL in .env.development
# ATLASSIAN_REDIRECT_URI=$NGROK_URL/api/oauth/callback
EOF

echo -e "${GREEN}✓ Created ${ENV_FILE}${NC}"
echo ""

echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "1. Update your OIDC provider (Azure AD) with the callback URL:"
echo -e "   ${BLUE}${NGROK_URL}/api/auth/oidc/callback${NC}"
echo ""
echo "2. Update Atlassian OAuth app with redirect URI:"
echo -e "   ${BLUE}${NGROK_URL}/api/oauth/callback${NC}"
echo ""
echo "3. Update .env.development or .env.local with:"
echo -e "   ${BLUE}PUBLIC_BASE_URL=${NGROK_URL}${NC}"
echo ""
echo "4. Start your application:"
echo -e "   ${BLUE}pnpm dev${NC}"
echo ""
echo "5. Visit your app:"
echo -e "   ${BLUE}${NGROK_URL}${NC}"
echo ""
echo "6. View ngrok dashboard:"
echo -e "   ${BLUE}http://127.0.0.1:4040${NC}"
echo ""

# Keep ngrok running in the foreground
echo -e "${YELLOW}ngrok is running. Press Ctrl+C to stop.${NC}"
wait $NGROK_PID
