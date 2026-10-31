import { NextRequest, NextResponse } from 'next/server';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { logger } from '@/lib/logger';

/**
 * Where a browser sends Content-Security-Policy violation reports
 * (lib/security-headers.ts names it as the policy's `report-uri` and as the
 * `csp` Reporting-Endpoints entry). The policy is report-only until its
 * reports say what the real surface is, and a policy that reports nowhere
 * says nothing.
 *
 * Unauthenticated by nature — the browser sends it with no credentials — so
 * it does the least it can: read a bounded body, keep the few fields that
 * name the directive and the blocked resource's origin (never a full URL,
 * whose query could carry anything), log them, and answer 204. A flood is
 * throttled like every other unauthenticated endpoint.
 */

const MAX_BODY_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The origin of a URL, or the keyword a report uses instead ("inline", "eval"); nothing else. */
function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return /^[a-z-]{1,24}$/.test(value) ? value : undefined;
  }
}

/** Both report formats: the legacy `{ "csp-report": {…} }` and Reporting API `[{ type, body }]`. */
function violationsOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.flatMap((entry) =>
      isRecord(entry) && entry.type === 'csp-violation' && isRecord(entry.body) ? [entry.body] : []
    );
  }
  if (isRecord(body) && isRecord(body['csp-report'])) return [body['csp-report']];
  return [];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verdict = checkInboundLimit('csp-report', request, {
    perClient: { limit: 30, windowMs: 60_000 },
    global: { limit: 300, windowMs: 60_000 },
  });
  if (!verdict.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
    });
  }

  const raw = await request.text().catch(() => '');
  if (raw.length > 0 && raw.length <= MAX_BODY_BYTES) {
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    for (const violation of violationsOf(body).slice(0, 5)) {
      const directive = violation.effectiveDirective ?? violation['effective-directive'];
      const blocked = violation.blockedURL ?? violation['blocked-uri'];
      const document = violation.documentURL ?? violation['document-uri'];
      logger.warn('CSP violation: {directive} blocked {blocked}', {
        component: 'api/csp-report',
        directive: typeof directive === 'string' ? directive.slice(0, 40) : 'unknown',
        blocked: originOf(blocked) ?? 'unknown',
        page: (() => {
          try {
            return typeof document === 'string' ? new URL(document).pathname : undefined;
          } catch {
            return undefined;
          }
        })(),
      });
    }
  }
  return new NextResponse(null, { status: 204 });
}
