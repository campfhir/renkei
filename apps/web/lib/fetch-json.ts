/**
 * The client-side fetch helpers every CRUD form re-implemented — hoisted
 * on their third copy (email-sanitizer rule-forms and connector-forms each
 * carry a private one; the agents builder is the third caller).
 *
 * Errors come back as values, never throws: forms render a message, they
 * do not crash. `sendJsonFull` exists for callers that need the response
 * body on success (the agents builder reads generated descriptions and
 * one-time API keys out of save responses).
 *
 * Every failure is also reported through the client logger (`client/fetch`
 * in Activity) with the method, path, status and the server's error text,
 * so a form that says "failed" leaves a line saying why. A 401 is the
 * session ending, not a failure, and is not reported.
 */

import { clientLogger } from './client-logger';

/** For a caller that fetches by hand (a file upload): reports a failure the way the helpers do. */
export function reportFetchFailure(
  method: string,
  url: string,
  status: number,
  error: string,
  cause?: unknown
): void {
  if (status === 401) return;
  const path = url.split('?')[0];
  const attrs = { method, path, status, detail: error };
  if (status === 0) clientLogger.error('fetch', `${method} ${path} could not reach the server`, cause, attrs);
  else if (status >= 500) clientLogger.error('fetch', `${method} ${path} failed (${status})`, undefined, attrs);
  else clientLogger.warn('fetch', `${method} ${path} refused (${status})`, undefined, attrs);
}

export async function getJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`;
      reportFetchFailure('GET', url, response.status, message);
      return { data: null, error: message };
    }
    return { data: body, error: null };
  } catch (error) {
    reportFetchFailure('GET', url, 0, 'Could not reach the server', error);
    return { data: null, error: 'Could not reach the server' };
  }
}

export async function sendJson(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<string | null> {
  const result = await sendJsonFull(url, method, body);
  return result.error;
}

export async function sendJsonFull<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  /** Let the request outlive the page (an unload-time save). */
  keepalive = false
): Promise<{ data: T | null; status: number; error: string | null }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(keepalive ? { keepalive: true } : {}),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof parsed?.error === 'string' ? parsed.error : `Request failed (${response.status})`;
      reportFetchFailure(method, url, response.status, message);
      return { data: parsed, status: response.status, error: message };
    }
    return { data: parsed, status: response.status, error: null };
  } catch (error) {
    reportFetchFailure(method, url, 0, 'Could not reach the server', error);
    return { data: null, status: 0, error: 'Could not reach the server' };
  }
}
