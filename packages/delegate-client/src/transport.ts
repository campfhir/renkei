/**
 * How every caller reaches the delegate (apps/worker-delegate): one POST
 * per op, the shared bearer key, a JSON body, and the delegate's error
 * envelope mapped to a typed verdict. The web app's Mirth, ADManager and
 * OnBase service clients have this same shape; the delegate's is kept as
 * a package because the workers call it too.
 *
 * Configuration: DELEGATE_WORKER_URL plus THIS process's own bearer key —
 * `DELEGATE_WORKER_API_KEY`, or the entry named by `DELEGATE_WORKER_CALLER`
 * in a shared `DELEGATE_WORKER_API_KEYS` map (`web=…,worker=…,agents=…`).
 * Each process presents a key of its own, and the delegate's allow-list
 * (apps/worker-delegate/src/callers.ts) decides what that key may do.
 * Absent means every op answers `DELEGATE_UNCONFIGURED`: with no delegate
 * there is no key, and nothing opens. The compose file's development
 * default key is refused outright under NODE_ENV=production.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Err, Result } from '@campfhir/safe-functions/types';
import { log } from '@renkei/logging';

export interface DelegateConfig {
  url: string;
  apiKey: string;
}

/** The two verdicts that are about reaching the delegate rather than about the op. */
export type DelegateTransportError = 'DELEGATE_UNCONFIGURED' | 'DELEGATE_UNREACHABLE';

/**
 * An op's failure: the tag is the delegate's own error type, verbatim
 * (`KEY_LOCKED`, `NO_ACCESS`, …), or one of the transport verdicts; the
 * HTTP status rides in `cause` for the callers that map statuses.
 */
export type DelegateCallError = Err<string>;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Retrying a call the delegate never took. A keep-alive socket the
 * delegate closed as idle in the same instant this process reused it, or
 * a delegate restarting (a deploy, a crash and its restart), fails the
 * request at the connection — nothing reached a handler — and a page
 * made the error its own: every chat on it read as "the key service
 * could not be reached" for one dropped socket. Only a call the caller
 * marks safe to repeat (`retry`): a read, never a write, which may have
 * started before the connection dropped. The delays are short — a
 * fresh connection is all a stale socket needs — and never apply to a
 * timeout, whose request may be running.
 */
const RETRY_DELAYS_MS = [250, 1_000];
let retryDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: the wait between retries, without real time passing. */
export function setRetryDelayForTests(delay: ((ms: number) => Promise<void>) | null): void {
  retryDelay = delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * A fetch that never reached the delegate's handler: refused, reset, or
 * the socket gone under it (undici's "other side closed"). Not a
 * timeout: that request may be running.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return false;
  const cause: { code?: unknown; message?: unknown } | undefined =
    typeof error.cause === 'object' && error.cause !== null ? error.cause : undefined;
  if (typeof cause?.code === 'string' && CONNECTION_FAILURE_CODES.has(cause.code)) return true;
  if (typeof cause?.message === 'string' && /other side closed|socket hang up/i.test(cause.message))
    return true;
  return (
    [...CONNECTION_FAILURE_CODES].some((code) => error.message.includes(code)) ||
    /other side closed|socket hang up/i.test(error.message)
  );
}

/** The bearer key prefix the compose files ship for development (one per caller); worthless in production. */
export const DEVELOPMENT_DELEGATE_KEY = 'renkei-dev-delegate-key';

/** This process's own key: `DELEGATE_WORKER_API_KEY`, else its named entry in `DELEGATE_WORKER_API_KEYS`. */
export function delegateApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.DELEGATE_WORKER_API_KEY?.trim();
  if (own) return own;
  const caller = env.DELEGATE_WORKER_CALLER?.trim();
  if (!caller) return null;
  for (const entry of (env.DELEGATE_WORKER_API_KEYS ?? '').split(',')) {
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    if (entry.slice(0, equals).trim() !== caller) continue;
    const key = entry.slice(equals + 1).trim();
    if (key) return key;
  }
  return null;
}

/**
 * Why this process must not run with its delegate key, or null when it may:
 * the development default under NODE_ENV=production is a key everyone has.
 * Called at boot by every process that holds a key, and again by
 * `delegateConfigFromEnv`, which throws rather than present it.
 */
export function developmentDelegateKeyRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (!delegateApiKeyFromEnv(env)?.startsWith(DEVELOPMENT_DELEGATE_KEY)) return null;
  return (
    `DELEGATE_WORKER_API_KEY is the development default (${DEVELOPMENT_DELEGATE_KEY}) with NODE_ENV=production. ` +
    "Give this process a key of its own (openssl rand -base64 32) and name it in the delegate's DELEGATE_WORKER_API_KEYS."
  );
}

let unconfiguredReported = false;

/** Test-only: let the next unconfigured boot say so again. */
export function resetDelegateUnconfiguredReportForTests(): void {
  unconfiguredReported = false;
}

/**
 * Reads DELEGATE_WORKER_URL and this process's own delegate key. Every
 * process calls this once at boot (DelegateClient.fromEnv,
 * DelegateGrants.fromEnv), so this is also where a production process with
 * no delegate says so — once, at error level, instead of only as
 * `DELEGATE_UNCONFIGURED` on each op later: with no delegate no chat opens
 * and no connector acts, and the compose file that forgot the service
 * should be found at boot, not from the first person's failed request.
 * Development stays quiet, since a developer may well run the app without
 * one. The development default key is refused outright in production.
 */
export function delegateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => void = (message) => console.error(message)
): DelegateConfig | null {
  const refusal = developmentDelegateKeyRefusal(env);
  if (refusal) throw new Error(refusal);
  const url = env.DELEGATE_WORKER_URL?.trim();
  const apiKey = delegateApiKeyFromEnv(env);
  if (!url || !apiKey) {
    if (env.NODE_ENV === 'production' && !unconfiguredReported) {
      unconfiguredReported = true;
      const missing = [!url && 'DELEGATE_WORKER_URL', !apiKey && 'DELEGATE_WORKER_API_KEY']
        .filter(Boolean)
        .join(' and ');
      report(
        `ERROR [delegate-client]: ${missing} not set in production — the delegate is unreachable from this process, so every key, token and connector operation will answer DELEGATE_UNCONFIGURED (docker-compose.yaml wires both on each service; DEPLOYMENT.md, "worker-delegate").`
      );
    }
    return null;
  }
  let base = url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return { url: base, apiKey };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class DelegateTransport {
  constructor(
    private readonly config: DelegateConfig | null,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    /** Fields put on every body: the session or run the calls are bound to (`forSession`, `forRun`). */
    private readonly bound: Readonly<Record<string, unknown>> = {}
  ) {}

  get configured(): boolean {
    return this.config !== null;
  }

  /** The same transport with more fields bound to every body. */
  withBound(fields: Record<string, unknown>): DelegateTransport {
    return new DelegateTransport(this.config, this.fetchImpl, { ...this.bound, ...fields });
  }

  /** The body with the bound fields filled in wherever the op left them unset. */
  private withBoundFields(body: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...body };
    for (const [name, value] of Object.entries(this.bound)) {
      if (merged[name] === undefined) merged[name] = value;
    }
    return merged;
  }

  /**
   * One op; the parsed JSON body on 2xx, the delegate's error tag
   * otherwise. `retry` marks an op safe to send again after a dropped
   * connection (a read); a write is sent exactly once.
   */
  async call(
    op: string,
    body: Record<string, unknown>,
    options: { retry?: boolean } = {}
  ): Promise<Result<Record<string, unknown>, string>> {
    if (!this.config) return err('DELEGATE_UNCONFIGURED');
    const payload = JSON.stringify(this.withBoundFields(body));
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.fetchImpl(`${this.config.url}/v1/${op}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
          },
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        break;
      } catch (cause) {
        log.warn('Delegate request {op} failed on attempt {attempt}: {message}', {
          component: 'delegate-client/transport',
          op,
          attempt: attempt + 1,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        const delay = RETRY_DELAYS_MS[attempt];
        if (options.retry === true && delay !== undefined && isConnectionFailure(cause)) {
          await retryDelay(delay);
          continue;
        }
        return err('DELEGATE_UNREACHABLE', { cause });
      }
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(json) && isRecord(json.error) ? json.error : {};
      return err(typeof error.type === 'string' ? error.type : 'internal', {
        message: typeof error.message === 'string' ? error.message : undefined,
        cause: { status: response.status },
      });
    }
    if (!isRecord(json)) return err('DELEGATE_UNREACHABLE');
    return ok(json);
  }
}
