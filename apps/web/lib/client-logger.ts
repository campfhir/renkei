/**
 * The browser's logger. A failure the browser sees (a request that answered
 * an error, a caught exception, a render that hit the error boundary) is
 * written to the console as before AND posted to `app/api/logs/client`,
 * which logs it through the server's logger under the signed-in person's
 * subject — so it lands in their Activity view beside the server's lines.
 *
 * Fire and forget: reporting never throws, never awaits in the caller's
 * path, and a report that cannot be delivered is dropped (logging the
 * failure to log would only loop). Identical lines within a few seconds are
 * sent once, so a component re-rendering into the same error does not flood.
 *
 * Usage, in the service/component scheme the server uses:
 *
 *   clientLogger.error('chat/ocr', 'could not start OCR', error, { artifactId });
 *   clientLogger.warn('preferences', 'save refused', undefined, { status: 409 });
 */

import type { ClientLogBody, ClientLogLevel } from './client-log-body';

type Attrs = Record<string, string | number | boolean | null | undefined>;

const ENDPOINT = '/api/logs/client';
const DEDUPE_MS = 5_000;
const recent = new Map<string, number>();

function describe(error: unknown): { message: string | null; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack };
  if (error === undefined || error === null) return { message: null };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function seenRecently(key: string, now: number): boolean {
  const last = recent.get(key);
  if (recent.size > 200) recent.clear();
  recent.set(key, now);
  return last !== undefined && now - last < DEDUPE_MS;
}

function send(
  level: ClientLogLevel,
  component: string,
  message: string,
  error?: unknown,
  attrs: Attrs = {}
): void {
  const described = describe(error);
  const consoleArgs: unknown[] = [`[${component}] ${message}`, ...(error === undefined ? [] : [error])];
  if (level === 'error') console.error(...consoleArgs);
  else if (level === 'warn') console.warn(...consoleArgs);
  else console.info(...consoleArgs);

  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  const text = described.message ? `${message}: ${described.message}` : message;
  if (seenRecently(`${level}|${component}|${text}`, Date.now())) return;

  const clean: ClientLogBody['attrs'] = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) clean[key] = value;
  }
  const body: ClientLogBody = {
    level,
    component,
    message: text,
    attrs: clean,
    page: window.location.pathname,
    ...(described.stack ? { stack: described.stack } : {}),
  };
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Survives the page unloading right after the failure.
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined);
  } catch {
    // A report that cannot be sent is dropped; see the header.
  }
}

export const clientLogger = {
  error: (component: string, message: string, error?: unknown, attrs?: Attrs) =>
    send('error', component, message, error, attrs),
  warn: (component: string, message: string, error?: unknown, attrs?: Attrs) =>
    send('warn', component, message, error, attrs),
  info: (component: string, message: string, attrs?: Attrs) =>
    send('info', component, message, undefined, attrs),
};

/**
 * A response that did not come back ok, logged with its status and the
 * server's own error text when it sent one. Reads a clone, so the caller can
 * still read the body.
 */
export async function logFailedResponse(
  component: string,
  message: string,
  response: Response,
  attrs: Attrs = {}
): Promise<void> {
  let detail: string | undefined;
  try {
    const text = await response.clone().text();
    try {
      const parsed: unknown = JSON.parse(text);
      detail =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String(parsed.error)
          : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = undefined;
  }
  send(response.status >= 500 ? 'error' : 'warn', component, message, undefined, {
    ...attrs,
    status: response.status,
    url: new URL(response.url || '/', 'http://x').pathname,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  });
}
