#!/bin/bash

# Start development with ngrok tunnel
# This script combines ngrok and docker-compose/pnpm dev

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
USE_DOCKER=${1:-"docker"}
RESET_VOLUME=${2:-""}

if [ "$USE_DOCKER" != "docker" ] && [ "$USE_DOCKER" != "local" ]; then
  echo -e "${RED}Usage: $0 [docker|local] [--reset]${NC}"
  echo ""
  echo "Examples:"
  echo "  $0 docker         # Use Docker with ngrok"
  echo "  $0 local          # Use pnpm dev with ngrok"
  echo "  $0 docker --reset # Reset Docker volumes"
  exit 1
fi

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
  echo -e "${RED}✗ ngrok is not installed${NC}"
  echo ""
  echo "Install ngrok:"
  echo "  macOS: brew install ngrok"
  echo "  Or: https://ngrok.com/download"
  exit 1
fi

# Cleanup function
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"

  if [ "$USE_DOCKER" = "docker" ]; then
    docker-compose down 2>/dev/null || true
  fi

  pkill -f "ngrok http" || true
  echo -e "${GREEN}✓ Cleaned up${NC}"
}

# Set up trap to cleanup on exit
trap cleanup EXIT INT TERM

echo -e "${BLUE}Starting development environment with ngrok...${NC}"
echo ""

# Start ngrok in background
echo -e "${BLUE}[1/3] Starting ngrok tunnel on port 3000...${NC}"
NGROK_LOG=$(mktemp)
ngrok http 3000 --log=stdout > "$NGROK_LOG" 2>&1 &
NGROK_PID=$!

sleep 2

# Extract ngrok URL
NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o 'https://[a-z0-9-]*\.ngrok\.io' | head -1)

if [ -z "$NGROK_URL" ]; then
  NGROK_URL=$(grep -oE 'https://[a-z0-9-]+\.ngrok\.io' "$NGROK_LOG" | head -1)
fi

if [ -z "$NGROK_URL" ]; then
  echo -e "${RED}✗ Could not extract ngrok URL${NC}"
  kill $NGROK_PID 2>/dev/null || true
  rm -f "$NGROK_LOG"
  exit 1
fi

rm -f "$NGROK_LOG"

echo -e "${GREEN}✓ ngrok tunnel: ${BLUE}${NGROK_URL}${NC}"
echo ""

# Create temporary .env file for this session
echo -e "${BLUE}[2/3] Configuring environment...${NC}"

ENV_TEMP=".env.dev-temp"
if [ -f .env.development ]; then
  cp .env.development "$ENV_TEMP"
fi

# Add/override PUBLIC_BASE_URL
if grep -q "^PUBLIC_BASE_URL=" "$ENV_TEMP" 2>/dev/null; then
  sed -i '' "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$NGROK_URL|" "$ENV_TEMP"
else
  echo "PUBLIC_BASE_URL=$NGROK_URL" >> "$ENV_TEMP"
fi

# Ensure TRUSTED_PROXY_IPS is set
if ! grep -q "^TRUSTED_PROXY_IPS=" "$ENV_TEMP" 2>/dev/null; then
  echo "TRUSTED_PROXY_IPS=127.0.0.1,::1,172.17.0.1" >> "$ENV_TEMP"
fi

echo -e "${GREEN}✓ Environment configured${NC}"
echo ""

# Start the application
echo -e "${BLUE}[3/3] Starting application...${NC}"
echo ""

if [ "$USE_DOCKER" = "docker" ]; then
  # Reset volumes if requested
  if [ "$RESET_VOLUME" = "--reset" ]; then
    echo -e "${YELLOW}Removing Docker volumes...${NC}"
    docker-compose down -v 2>/dev/null || true
    sleep 1
  fi

  # Load environment from temp file
  export $(cat "$ENV_TEMP" | grep -v '^#' | xargs)

  # Start docker-compose
  docker-compose -f docker-compose.yml up --build
else
  # Use pnpm dev
  export $(cat "$ENV_TEMP" | grep -v '^#' | xargs)

  pnpm dev
fi
