# Fastify → Next.js Migration Plan

## Completed
- [x] Next.js 15 project initialized
- [x] Dependencies installed
- [x] Source files copied to lib/
- [x] Config loading (lib/env.ts)
- [x] Database setup (lib/db.ts)

## In Progress
- [ ] **Core routes** (auth, OAuth, MCP gateway)
- [ ] **Admin UI** (pages + components)
- [ ] **Middleware** (OIDC, CSRF, auth)
- [ ] **Testing** (health checks, basic flows)

## Route Mapping (Fastify → Next.js)

### OAuth Routes (`/oauth/*`)
- GET `/oauth/authorize` → `app/api/oauth/authorize/route.ts`
- POST `/oauth/token` → `app/api/oauth/token/route.ts`  
- POST `/oauth/revoke` → `app/api/oauth/revoke/route.ts`

### MCP Gateway Routes (`/mcp/<siteId>`)
- POST `/mcp/<siteId>` → `app/api/mcp/[siteId]/route.ts`

### Admin Routes (`/admin/<slug>/*`)
- GET `/admin/<slug>` → `app/admin/[slug]/page.tsx`
- GET `/admin/<slug>/sites` → `app/admin/[slug]/sites/page.tsx`
- GET `/admin/<slug>/people` → `app/admin/[slug]/people/page.tsx`
- GET `/admin/<slug>/audit` → `app/admin/[slug]/audit/page.tsx`
- GET `/admin/<slug>/logs` → `app/admin/[slug]/logs/page.tsx` (NEW - interactive!)
- POST `/admin/<slug>/*` → corresponding route handlers
- GET `/api/admin/<slug>/logs` → `app/api/admin/[slug]/logs/route.ts`

### Onboarding Routes (`/` and `/create-organization`)
- GET `/` → `app/page.tsx`
- POST `/create-organization` → `app/api/create-organization/route.ts`

## Next Steps
1. Set up middleware (auth, OIDC, CSRF)
2. Migrate OAuth routes
3. Migrate admin routes (sign-in, console pages)
4. Migrate MCP gateway route
5. Wire up the interactive logs page
6. Test end-to-end
