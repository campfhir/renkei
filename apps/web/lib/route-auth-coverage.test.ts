/**
 * DENY BY DEFAULT for the whole HTTP surface.
 *
 * The App Router gives us no framework hook that forces a route to be
 * authenticated, and Next's own guidance rules out the two places one
 * instinctively reaches for: a layout check does not re-run on client-side
 * navigation (partial rendering), and the proxy cannot resolve a slug to the
 * tenant id that names the session cookie without the database. So the guard
 * lives per route — which means the only thing standing between us and a
 * forgotten check is this test.
 *
 * The rule: every `page.tsx` and every `route.ts` must either reference a
 * SESSION guard, or be named below with the mechanism that protects it
 * instead. A new file that does neither fails this test. Adding an entry is
 * deliberately a code review event: you are writing down, in one line, why
 * this path may be reached without a session.
 *
 * What this test does NOT do is verify the mechanism works — `verifyZoomSignature`
 * being imported is not proof it is called correctly. It proves only that
 * someone made a decision here, and that nobody added a route without making
 * one. The mechanisms themselves are tested by their own suites.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const APP_DIR = join(__dirname, '..', 'app');

/** Symbols that resolve a signed-in user's session. The default expectation. */
const SESSION_GUARDS = ['checkAccess', 'getSessionFromCookies', 'getSessionFromRequest'];

/**
 * Reachable without a session, but NOT unauthenticated: each carries its own
 * credential. The note names the mechanism a reviewer should go verify.
 */
const NON_SESSION_AUTH: Record<string, string> = {
  'api/auth/oidc/callback/route.ts': 'single-use OIDC state row; mints the session itself',
  'api/logs/route.ts': 'LOG_SHIP_API_KEY bearer gate inside lib/log-ingest',
  'api/logs/register/route.ts': 'same LOG_SHIP_API_KEY bearer gate (trust on first use)',
  'api/mcp/[tenantId]/[transport]/route.ts': 'MCP access-token bearer (resolveAccessToken)',
  'api/tenant/[tenantId]/agents/draft/[draftId]/run/route.ts':
    'agent-worker bearer (resolveAccessToken, application "agent"); the token names the ' +
    'subject the draft is built for, and the row is read under that subject',
  'api/tenant/[tenantId]/agents/optimize/[optimizationId]/run/route.ts':
    'agent-worker bearer (resolveAccessToken, application "agent"); the token names the ' +
    'owner whose run history the analysis may read, and the row is read under that subject',
  'api/mcp/[tenantId]/oauth/token/route.ts':
    'OAuth token endpoint: client secret + PKCE code_verifier',
  'api/oauth/callback/route.ts': 'single-use OAuth state row bound to the pending authorization',
  'api/upload/[slotId]/route.ts': 'opaque per-slot bearer, single-use claim, expiring',
  'api/webhooks/microsoft/[tenantId]/[accountId]/route.ts':
    'per-subscription clientState secret matched against webhook_subscriptions',
  'api/webhooks/webex/[tenantId]/user/[accountId]/route.ts':
    'x-spark-signature HMAC over raw bytes, per-user grant secret',
  'api/webhooks/zoom/[tenantId]/route.ts': 'x-zm-signature HMAC over raw bytes',
};

/**
 * Deliberately reachable by anyone. Every entry is a decision to expose
 * something to the open internet — keep the list short and the reasons real.
 */
const PUBLIC: Record<string, string> = {
  // Sign-in entry points: there is by definition no session yet.
  'page.tsx': 'home-realm sign-in landing — collects an email, starts discovery',
  'create-organization/page.tsx': 'org onboarding form; the endpoints it posts to enforce access',
  'api/auth/oidc/login/route.ts': 'starts the OIDC redirect — the thing that creates sessions',
  'api/home-realm/route.ts': 'home-realm discovery: maps an email domain to its tenant',
  'api/home-realm/create/route.ts':
    'self-service onboarding — no session can exist before the first tenant; ' +
    'throttled per-client and globally (checkInboundLimit)',
  // Protocol discovery documents. Public by specification.
  'api/.well-known/oauth-authorization-server/route.ts': 'RFC 8414 metadata, public by spec',
  'api/.well-known/oauth-protected-resource/route.ts': 'RFC 9728 metadata, public by spec',
  'api/mcp/[tenantId]/.well-known/oauth-authorization-server/route.ts':
    'RFC 8414 metadata, public by spec',
  'api/mcp/[tenantId]/.well-known/oauth-protected-resource/route.ts':
    'RFC 9728 metadata, public by spec',
  'api/mcp/[tenantId]/oauth/register/route.ts': 'RFC 7591 dynamic client registration',
  'api/oauth/register/route.ts': 'RFC 7591 dynamic client registration',
  // Operational.
  'api/health/route.ts': 'liveness probe — content-free',
};

/**
 * Pages that hold no data of their own: they only redirect. Nothing to leak,
 * and the destination guards itself.
 */
const REDIRECT_ONLY: Record<string, string> = {
  '[slug]/home/page.tsx': 'redirects to /{slug}',
  '[slug]/admin/grants/page.tsx': 'redirects to /{slug}/admin/people',
};

/**
 * Pages whose data comes from a server action that resolves the session and
 * reports `signedOut`; the page redirects to sign-in on that verdict. The
 * check is real, it just lives one call deeper (the Data Access Layer shape
 * Next recommends).
 */
const GUARDED_BY_ACTION: Record<string, string> = {
  '[slug]/logs/page.tsx': 'searchLogs resolves the session and scope',
  '[slug]/usage/page.tsx': 'getUsageReport resolves the session and scope',
  '[slug]/utilization/page.tsx':
    "getUtilizationReport resolves the session; subject is the session's own",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === 'page.tsx' || entry === 'route.ts') out.push(full);
  }
  return out;
}

/** Posix-style path relative to app/, so the tables read the same on Windows. */
function keyOf(file: string): string {
  return relative(APP_DIR, file).split(sep).join('/');
}

describe('every HTTP entry point makes an auth decision', () => {
  const files = walk(APP_DIR).sort();

  it('finds the routes to check (guards against a broken walk)', () => {
    // A refactor that moves the app directory must fail loudly here rather
    // than silently declaring an empty surface fully covered.
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [keyOf(file), file]))('%s', (key, file) => {
    const source = readFileSync(file, 'utf8');
    const hasSessionGuard = SESSION_GUARDS.some((guard) => source.includes(guard));
    const exempt =
      key in NON_SESSION_AUTH || key in PUBLIC || key in REDIRECT_ONLY || key in GUARDED_BY_ACTION;

    if (!hasSessionGuard && !exempt) {
      throw new Error(
        `${key} neither checks the session nor is listed as an exception.\n` +
          `Add a session guard (${SESSION_GUARDS.join(' / ')}), or — if it is genuinely ` +
          `reachable without one — add it to NON_SESSION_AUTH / PUBLIC / REDIRECT_ONLY / ` +
          `GUARDED_BY_ACTION in ${relative(process.cwd(), __filename)} with the reason.`
      );
    }
  });

  it('has no stale exception entries', () => {
    const present = new Set(files.map(keyOf));
    const listed = [
      ...Object.keys(NON_SESSION_AUTH),
      ...Object.keys(PUBLIC),
      ...Object.keys(REDIRECT_ONLY),
      ...Object.keys(GUARDED_BY_ACTION),
    ];
    // An exception outliving its route is how an allowlist rots into a
    // rubber stamp: the next file to take that path inherits the exemption.
    expect(listed.filter((key) => !present.has(key))).toEqual([]);
  });

  it('every exception carries a reason', () => {
    for (const table of [NON_SESSION_AUTH, PUBLIC, REDIRECT_ONLY, GUARDED_BY_ACTION]) {
      for (const [key, reason] of Object.entries(table)) {
        expect(`${key}: ${reason.trim()}`.length).toBeGreaterThan(key.length + 12);
      }
    }
  });
});
