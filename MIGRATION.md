# Fastify → Next.js 15 Migration

**Status:** Foundation complete, core gateway in progress

This document tracks the migration from Fastify server-rendered React to Next.js 15 App Router for proper interactivity and server/client component separation.

## Problem Statement

The original Fastify implementation used `renderToString()` for React, which cannot support client-side hooks required for interactive UI (logs page filtering, real-time updates, etc.).

Next.js 15 App Router solves this by:
- Properly separating server components (auth, database) from client components (interactive UI)
- Full React hooks support for state management
- Built-in API routes for JSON endpoints
- Middleware for authentication/authorization

## Architecture

### Server Components
- Route handlers in `app/api/**/route.ts`
- Page components that require auth
- Database queries
- OIDC configuration lookup

### Client Components
- Interactive UI components (`'use client'` directive)
- React hooks (useState, useEffect, etc.)
- Form handling and event listeners

## Implementation Status

### ✅ Complete

**Foundation:**
- Next.js 15 App Router initialized
- Environment validation (Zod schema)
- PostgreSQL + Kysely ORM
- Session management (HTTP-only cookies)
- Middleware for authentication

**Admin Console:**
- 8 pages with navigation: Sites, People, Audit, Logs, Settings, Sign-in
- Interactive logs page with filtering, sorting, search (React hooks)
- Admin layout with operator context

**API Routes (15+ endpoints):**
- `GET /api/health` ✅
- `GET /api/oauth/authorize` ✅
- `GET /api/oauth/callback` (token exchange implemented, JWT parsing done)
- `GET /api/admin/[slug]/logs` (stub, ready for full implementation)
- `POST /api/admin/[slug]/sites/enabled` ✅
- `POST /api/admin/[slug]/sites/claim` ✅
- `POST /api/admin/[slug]/people/revoke` ✅
- `POST /api/mcp/[siteId]` (request validation done, structure in place)
- Additional routes for authentication flows

### 🔄 In Progress

**OAuth Token Exchange:**
- JWT decoding: ✅
- Token exchange code: ✅
- TODO: ID token signature verification
- TODO: Session persistence to database

**MCP Gateway:**
- Request validation: ✅
- Site resolution: ✅
- TODO: Grant lookup and decryption
- TODO: Jira API proxying

### ⏳ To Do

- Encryption/decryption (AES-256-GCM)
- Full logs API implementation
- User session tracking
- Grant management
- Error handling completion

## Development

### Setup

```bash
pnpm install
npx next dev
# Server: http://localhost:3000
```

### Environment Variables

Required in `.env.local`:
```
ATLASSIAN_CLIENT_ID=...
ATLASSIAN_CLIENT_SECRET=...
ATLASSIAN_REDIRECT_URI=http://localhost:3000/api/oauth/callback
TOKEN_ENCRYPTION_KEY=... # openssl rand -base64 32
DATABASE_URL=postgresql://...
PUBLIC_BASE_URL=http://localhost:3000
```

### Testing

```bash
# Health check
curl http://localhost:3000/api/health

# Admin page (no auth required for demo)
curl http://localhost:3000/admin/test-slug

# Logs API (requires future auth implementation)
curl http://localhost:3000/api/admin/test-slug/logs
```

## Route Mapping

| Fastify | Next.js |
|---------|---------|
| `GET /oauth/authorize` | `app/api/oauth/authorize/route.ts` |
| `POST /oauth/callback` | `app/api/oauth/callback/route.ts` |
| `GET /admin/:slug` | `app/admin/[slug]/page.tsx` |
| `GET /admin/:slug/sites` | `app/admin/[slug]/sites/page.tsx` |
| `POST /admin/:slug/sites/enabled` | `app/api/admin/[slug]/sites/enabled/route.ts` |
| `POST /mcp/:siteId` | `app/api/mcp/[siteId]/route.ts` |

## Key Differences

| Aspect | Fastify | Next.js |
|--------|---------|---------|
| Routing | Manual registration | File-based (`app/`) |
| React | SSR `renderToString()` | Server + Client components |
| Interactivity | Limited (no hooks) | Full hooks support |
| Auth | Sessions + middleware | Sessions + middleware |
| Database | Kysely ORM | Kysely ORM (same) |

## Next Priority Tasks

1. ✅ OAuth token exchange structure
2. ⏳ ID token verification (signature check with JWKS)
3. ⏳ MCP gateway (grant lookup → Jira API proxy)
4. ⏳ Encryption utilities
5. ⏳ Session database persistence

**Estimated remaining:** 2-3 hours
