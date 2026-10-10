#!/bin/bash

set -e

# Color output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for --reset flag to drop volumes
RESET_VOLUMES=false
if [[ "$1" == "--reset" ]]; then
  RESET_VOLUMES=true
fi

echo -e "${BLUE}🚀 Starting Renkei development environment...${NC}\n"

# Stop containers
echo -e "${BLUE}Stopping containers...${NC}"
if $RESET_VOLUMES; then
  docker compose down -v
  echo -e "${GREEN}✓ Containers stopped, volumes removed${NC}\n"
else
  docker compose down
  echo -e "${GREEN}✓ Containers stopped${NC}\n"
fi

# Build and start
echo -e "${BLUE}Building and starting containers...${NC}"
docker compose build --no-cache
docker compose up -d
echo -e "${GREEN}✓ Containers building and starting${NC}\n"

# Wait for app to be healthy
echo -e "${BLUE}Waiting for app to be healthy...${NC}"
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
  if docker exec renkei-app wget -q -O /dev/null http://localhost:3000/api/health 2>/dev/null; then
    echo -e "${GREEN}✓ App is healthy${NC}\n"
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ $attempt -eq $max_attempts ]; then
  echo -e "${YELLOW}⚠ App took longer than expected, but proceeding...${NC}\n"
fi

# Load environment variables safely
if [ ! -f .env.development ]; then
  echo -e "${YELLOW}⚠ .env.development not found, skipping identity provider setup${NC}"
  exit 0
fi

# Parse .env file safely (extract only our variables)
export PLATFORM_OIDC_DISCOVERY_ENDPOINT=$(grep '^PLATFORM_OIDC_DISCOVERY_ENDPOINT=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')
export PLATFORM_OIDC_CLIENT_ID=$(grep '^PLATFORM_OIDC_CLIENT_ID=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')
export PLATFORM_OIDC_CLIENT_SECRET=$(grep '^PLATFORM_OIDC_CLIENT_SECRET=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')

OPERATOR_EMAIL="scott.eremia-roden@nems.org"

# First-run setup: opening /setup mints the one-time setup secret into the
# app's log; the identity provider save presents it. Nothing to do once a
# provider exists (the page redirects home).
echo -e "${BLUE}Configuring the identity provider...${NC}"
SETUP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/setup)
if [ "$SETUP_STATUS" != "200" ]; then
  echo -e "${GREEN}✓ Identity provider already configured (setup page answered $SETUP_STATUS)${NC}\n"
else
  SETUP_SECRET=$(docker logs renkei-app 2>&1 | grep -o 'enter the setup secret [^ ]*' | tail -1 | awk '{print $NF}')
  if [ -z "$SETUP_SECRET" ]; then
    echo -e "${YELLOW}⚠ Could not read the setup secret from the app log; open http://localhost:3000/setup and finish by hand${NC}"
    exit 0
  fi
  OIDC_RESPONSE=$(curl -s -X POST http://localhost:3000/api/oidc \
    -H "Content-Type: application/json" \
    -H "X-Renkei-Setup-Secret: $SETUP_SECRET" \
    -d "{
      \"discoveryEndpoint\": \"$PLATFORM_OIDC_DISCOVERY_ENDPOINT\",
      \"clientId\": \"$PLATFORM_OIDC_CLIENT_ID\",
      \"clientSecret\": \"$PLATFORM_OIDC_CLIENT_SECRET\",
      \"roleClaim\": \"roles\",
      \"operatorIdpValue\": \"renkei-operator\",
      \"userIdpValue\": \"renkei-user\"
    }")

  if echo "$OIDC_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✓ OIDC configured${NC}\n"
  else
    echo -e "${YELLOW}⚠ OIDC configuration response: $OIDC_RESPONSE${NC}\n"
  fi
fi

# Print summary
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Renkei development environment is ready!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}\n"

echo -e "${BLUE}Quick Start:${NC}"
echo -e "  🌐 Open: ${BLUE}http://localhost:3000${NC}"
echo -e "  📧 Email: ${BLUE}$OPERATOR_EMAIL${NC}\n"

echo -e "${BLUE}OIDC Configuration:${NC}"
echo -e "  Discovery Endpoint: ${BLUE}$PLATFORM_OIDC_DISCOVERY_ENDPOINT${NC}"
echo -e "  Client ID: ${BLUE}$PLATFORM_OIDC_CLIENT_ID${NC}"
echo -e "  Role Claim: ${BLUE}roles${NC}"
echo -e "  Operator Role: ${BLUE}renkei-operator${NC}"
echo -e "  User Role: ${BLUE}renkei-user${NC}\n"

echo -e "${BLUE}Next Steps:${NC}"
echo -e "  1. Go to http://localhost:3000"
echo -e "  2. Sign in as $OPERATOR_EMAIL with Azure AD\n"

echo -e "${YELLOW}Tip: Use ${BLUE}./scripts/docker-dev-start.sh --reset${YELLOW} to drop volumes and start fresh${NC}\n"
