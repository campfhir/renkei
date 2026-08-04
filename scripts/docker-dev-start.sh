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
  echo -e "${YELLOW}⚠ .env.development not found, skipping tenant setup${NC}"
  exit 0
fi

# Parse .env file safely (extract only our variables)
export PLATFORM_OIDC_DISCOVERY_ENDPOINT=$(grep '^PLATFORM_OIDC_DISCOVERY_ENDPOINT=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')
export PLATFORM_OIDC_CLIENT_ID=$(grep '^PLATFORM_OIDC_CLIENT_ID=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')
export PLATFORM_OIDC_CLIENT_SECRET=$(grep '^PLATFORM_OIDC_CLIENT_SECRET=' .env.development | cut -d'=' -f2- | sed 's/^"//;s/"$//')

# Extract domain from email
OPERATOR_EMAIL="scott.eremia-roden@nems.org"
DOMAIN=$(echo "$OPERATOR_EMAIL" | sed 's/.*@//')

echo -e "${BLUE}Setting up first tenant for domain: $DOMAIN${NC}\n"

# Create tenant
echo -e "${BLUE}Creating tenant...${NC}"
TENANT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/home-realm/create \
  -H "Content-Type: application/json" \
  -d "{\"domain\": \"$DOMAIN\"}")

TENANT_ID=$(echo "$TENANT_RESPONSE" | grep -o '"tenantId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TENANT_ID" ]; then
  echo -e "${YELLOW}⚠ Failed to create tenant, response: $TENANT_RESPONSE${NC}"
  echo -e "\nTo manually create, run:"
  echo -e "  curl -X POST http://localhost:3000/api/home-realm/create \\\\"
  echo -e "    -H 'Content-Type: application/json' \\\\"
  echo -e "    -d '{\"domain\": \"$DOMAIN\"}'"
  exit 0
fi

echo -e "${GREEN}✓ Tenant created: $TENANT_ID${NC}\n"

# Configure OIDC
echo -e "${BLUE}Configuring OIDC...${NC}"
OIDC_RESPONSE=$(curl -s -X POST http://localhost:3000/api/tenant/$TENANT_ID/oidc \
  -H "Content-Type: application/json" \
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

# Print summary
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Renkei development environment is ready!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}\n"

echo -e "${BLUE}Quick Start:${NC}"
echo -e "  🌐 Open: ${BLUE}http://localhost:3000${NC}"
echo -e "  📧 Email: ${BLUE}$OPERATOR_EMAIL${NC}"
echo -e "  🔑 Tenant ID: ${BLUE}$TENANT_ID${NC}\n"

echo -e "${BLUE}OIDC Configuration:${NC}"
echo -e "  Discovery Endpoint: ${BLUE}$PLATFORM_OIDC_DISCOVERY_ENDPOINT${NC}"
echo -e "  Client ID: ${BLUE}$PLATFORM_OIDC_CLIENT_ID${NC}"
echo -e "  Role Claim: ${BLUE}roles${NC}"
echo -e "  Operator Role: ${BLUE}renkei-operator${NC}"
echo -e "  User Role: ${BLUE}renkei-user${NC}\n"

echo -e "${BLUE}Next Steps:${NC}"
echo -e "  1. Go to http://localhost:3000"
echo -e "  2. Enter email: $OPERATOR_EMAIL"
echo -e "  3. Configuration should be pre-loaded"
echo -e "  4. Authenticate with Azure AD\n"

echo -e "${YELLOW}Tip: Use ${BLUE}./scripts/docker-dev-start.sh --reset${YELLOW} to drop volumes and start fresh${NC}\n"
