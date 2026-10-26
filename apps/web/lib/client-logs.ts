'use client';

/**
 * Sends an error that happened in the browser to the server's log, with the
 * page it happened on and the browser that hit it. The server adds the
 * signed-in person, if there is one (app/api/client-logs). Fire and forget:
 * a report that cannot be sent is dropped, never shown to the person.
 */
export function reportClientError(error: unknown, component = 'web/client'): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    void fetch('/api/client-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        component,
        message,
        stack,
        page: `${location.pathname}${location.search}`,
        browserAgent: navigator.userAgent,
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting an error must never raise one of its own.
  }
}

declare global {
  interface Window {
    __renkeiPageHeader?: boolean;
  }
}

/** The header that tells the server which page a request came from. */
const PAGE_HEADER = 'x-renkei-page';
const MAX_PAGE_CHARS = 300;

/**
 * Adds the page the person is on to every same-origin API request, so a
 * server log line written while answering it names the page it came from.
 * Installed once; other requests are left exactly as they were.
 */
export function sendPageWithApiRequests(): void {
  if (window.__renkeiPageHeader) return;
  window.__renkeiPageHeader = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) {
      return original(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set(PAGE_HEADER, `${location.pathname}${location.search}`.slice(0, MAX_PAGE_CHARS));
    return original(input, { ...init, headers });
  };
}
