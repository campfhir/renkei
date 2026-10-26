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
