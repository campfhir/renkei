/**
 * The one place a request to Microsoft Graph leaves this codebase.
 *
 * Everything above it — graphRequest here, the web app's Outlook and
 * SharePoint helpers — keeps its own parsing, logging and error wording;
 * this layer owns only what has to be true of EVERY call:
 *
 *  1. Per-process rate limiting by lane (LaneLimiter), as before.
 *  2. A per-mailbox concurrency gate. Exchange Online lets one app run about
 *     four operations against one mailbox at a time and answers the fifth
 *     with 503 CommandConcurrencyLimitReached — a ceiling on in-flight
 *     requests, not on rate, so the token bucket never saw it coming. A chat
 *     turn firing four reads at once, a bulk job's $batch (which Graph fans
 *     out four-wide by itself) and the worker's delta rounds all land on the
 *     same mailbox. The gate is keyed by the grant (the fetcher's
 *     `grantKey`), which names the mailbox as well as anything the callers
 *     have in common; drive, site and directory URLs are not gated, since
 *     they are not Exchange's limit.
 *
 * The request itself goes out through the caller's `AuthedFetch`: the
 * delegate worker attaches the Authorization header, refreshes the token
 * and retries a 401, so none of that happens here. Anything a caller puts
 * in Authorization is dropped by the delegate.
 *  3. Retry on a throttled answer (429, and 503 for the concurrency case),
 *     waiting what Retry-After says, bounded per lane. Only idempotent
 *     methods retry by default: Microsoft has been known to send the mail
 *     and still answer sendMail with this 503, so a blind POST retry can
 *     double-send. A caller that knows its POST is safe passes `retry: true`.
 *
 * The web app and the worker are separate processes, so each has its own
 * gate; MAILBOX_CONCURRENCY is sized so the two together stay at Exchange's
 * four, with a chained $batch (mail-batch.ts) counting as one.
 */

import type { AuthedFetch } from '@renkei/delegate-client';
import { GateTimeoutError, KeyedGate, LaneLimiter, type RequestLane } from '@renkei/rate-limit';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * Bounds every call out to Graph — see the identical comment in
 * connector-webex's client.ts.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * In-flight requests per mailbox per process. Two here plus two in the
 * other process is Exchange's four; interactive callers beyond that queue
 * for a moment instead of being refused.
 */
export const MAILBOX_CONCURRENCY = 2;

/** How long a request waits for a mailbox slot before giving up, per lane. */
const GATE_WAIT_MS: Record<RequestLane, number> = { interactive: 20_000, background: 60_000 };

/** Attempts per call (the first plus retries), per lane. */
const ATTEMPTS: Record<RequestLane, number> = { interactive: 3, background: 4 };

/** The longest single Retry-After honored, per lane — a hostile value must not hang a caller. */
const MAX_RETRY_WAIT_MS: Record<RequestLane, number> = { interactive: 10_000, background: 30_000 };

/** Backoff when a throttled answer carries no Retry-After. */
const DEFAULT_RETRY_WAIT_MS = 1_000;

/** Methods safe to re-send after a throttled answer without a caller's say-so. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);

/**
 * Process-scoped, split by lane — see `LaneLimiter` in @renkei/rate-limit.
 *
 * Background bounds bursts from the subscription health sweep (many
 * tenants/grants) and from delta-sync paging. Interactive keeps a reserve for
 * work a person is waiting on — above all the SharePoint ACL check, which
 * runs inside the retrieval gate's 3s budget and whose $batch call must not
 * queue behind a sweep, since anything unverified by the deadline is withheld
 * and reads as a denial.
 */
const limiter = new LaneLimiter({
  interactive: { capacity: 20, refillPerSecond: 10 },
  background: { capacity: 5, refillPerSecond: 5 },
});

const mailboxGate = new KeyedGate({ limit: MAILBOX_CONCURRENCY });

/** Options accepted alongside a standard RequestInit. */
export interface GraphFetchOptions {
  /** Defaults to 'background'; verifiers and MCP tools pass 'interactive'. */
  lane?: RequestLane;
  /**
   * Per-attempt ceiling override, for requests Graph is legitimately slow to
   * answer (delta pages of full mail bodies). The 15s default fits
   * interactive calls; a background sync page is worth waiting longer for
   * than it is worth failing, because a retry re-pays the same latency.
   */
  timeoutMs?: number;
  /**
   * Whether a throttled answer (429/503) is re-sent. Defaults to true for
   * idempotent methods and false for POST — see the header comment.
   */
  retry?: boolean;
  /** Gate key override; defaults to the fetcher's `grantKey` (one per mailbox). */
  mailboxKey?: string;
}

/** Is this Graph URL an Exchange (mailbox) resource, subject to the per-mailbox cap? */
export function isMailboxUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  // "/v1.0/me/messages", "/v1.0/users/{id}/events", "/v1.0/$batch"...
  const segments = path.split('/').filter(Boolean);
  const [, scope, subject, resource] = segments;
  if (scope === '$batch') return true;
  const first = scope === 'me' ? subject : scope === 'users' ? resource : undefined;
  if (!first) return false;
  // Graph's Outlook family: mail, calendar, contacts, To Do. Everything
  // else under /me (drive, photo, memberOf, ...) is another service.
  return (
    first.startsWith('mailfolders') ||
    first.startsWith('messages') ||
    first.startsWith('events') ||
    first.startsWith('calendar') ||
    first.startsWith('contact') ||
    first === 'todo' ||
    first === 'sendmail' ||
    first === 'findmeetingtimes' ||
    first === 'inferenceclassification' ||
    first === 'mailboxsettings' ||
    first === 'outlook'
  );
}

/** Whether Graph is telling the caller to back off rather than that the request is wrong. */
export function isThrottled(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * The header's value in milliseconds, or null when absent or unreadable.
 * Graph sends delay-seconds; the HTTP-date form is handled for completeness.
 */
export function retryAfterMs(headers: Headers | null | undefined): number | null {
  const raw = headerOf(headers, 'retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Retry-After in whole seconds for a person-facing message, or null. */
export function retryAfterSeconds(headers: Headers | null | undefined): number | null {
  const ms = retryAfterMs(headers);
  return ms === null ? null : Math.ceil(ms / 1000);
}

/**
 * A response's headers as a plain object for a log line. Bounded, and
 * without the fields that only repeat what the line already carries.
 * Graph's diagnostics — request-id, client-request-id, x-ms-ags-diagnostic,
 * Retry-After — are what Microsoft support asks for on a 5xx.
 */
export function headersForLog(headers: Headers | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  try {
    headers.forEach((value, name) => {
      const key = name.toLowerCase();
      if (key === 'content-length' || key === 'content-type') return;
      out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    });
  } catch {
    // A test double that is not a real Headers — nothing to log.
  }
  return out;
}

function headerOf(headers: Headers | null | undefined, name: string): string | null {
  if (!headers || typeof headers.get !== 'function') return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/** Replaceable so a test can collapse the retry wait and no other timer. */
export const retryClock = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Free the connection behind an answer whose body nobody will read. */
async function discardBody(response: Response): Promise<void> {
  try {
    if (typeof response.arrayBuffer === 'function') await response.arrayBuffer();
  } catch {
    // Already consumed, or a double without a body.
  }
}

/**
 * Send one request to Graph with the limiter, the mailbox gate and the
 * throttle retry applied. Resolves with the final Response — still a 429 or
 * 503 when the retries ran out, so callers keep their own status handling.
 * Rejects the way fetch does (a TimeoutError on the per-attempt deadline),
 * plus GateTimeoutError when no mailbox slot freed up in time.
 */
export async function graphFetch(
  auth: AuthedFetch,
  pathOrUrl: string,
  init?: RequestInit & GraphFetchOptions
): Promise<Response> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE_URL}${pathOrUrl}`;
  const lane: RequestLane = init?.lane ?? 'background';
  const method = (init?.method ?? 'GET').toUpperCase();
  const retry = init?.retry ?? IDEMPOTENT_METHODS.has(method);
  const attempts = retry ? ATTEMPTS[lane] : 1;
  const timeoutMs = init?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const gated = isMailboxUrl(url);
  const gateKey = init?.mailboxKey ?? auth.grantKey;

  // Kept as a plain object when the caller gave one (test doubles read
  // keys back case-sensitively). No Authorization is added: the delegate
  // behind `auth` attaches it.
  const given = init?.headers;
  const headers: Record<string, string> = {};
  if (given instanceof Headers || Array.isArray(given)) {
    new Headers(given).forEach((value, name) => {
      headers[name] = value;
    });
  } else if (given) {
    for (const [name, value] of Object.entries(given)) {
      if (typeof value === 'string') headers[name] = value;
    }
  }

  // The options this layer consumes must not reach fetch as unknown keys.
  const { lane: _lane, timeoutMs: _timeout, retry: _retry, mailboxKey: _key, ...rest } = init ?? {};
  void _lane;
  void _timeout;
  void _retry;
  void _key;

  for (let attempt = 1; ; attempt += 1) {
    await limiter.take(lane);
    const release = gated ? await mailboxGate.acquire(gateKey, GATE_WAIT_MS[lane]) : null;
    let response: Response;
    try {
      response = await auth(url, {
        ...rest,
        headers,
        // A caller-supplied signal still wins — theirs may carry its own
        // cancellation semantics we should not override. Ours is per
        // attempt: a retry deserves a fresh deadline.
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } finally {
      if (release) release();
    }

    if (!isThrottled(response.status) || attempt >= attempts) return response;

    const asked = retryAfterMs(response.headers);
    const wait = Math.min(
      asked ?? DEFAULT_RETRY_WAIT_MS * 2 ** (attempt - 1),
      MAX_RETRY_WAIT_MS[lane]
    );
    await discardBody(response);
    await retryClock.sleep(wait);
  }
}

export { GateTimeoutError };
