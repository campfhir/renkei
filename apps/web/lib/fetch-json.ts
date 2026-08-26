/**
 * The client-side fetch helpers every CRUD form re-implemented — hoisted
 * on their third copy (email-sanitizer rule-forms and connector-forms each
 * carry a private one; the agents builder is the third caller).
 *
 * Errors come back as values, never throws: forms render a message, they
 * do not crash. `sendJsonFull` exists for callers that need the response
 * body on success (the agents builder reads generated descriptions and
 * one-time API keys out of save responses).
 */

export async function getJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`;
      return { data: null, error: message };
    }
    return { data: body, error: null };
  } catch {
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
  body?: unknown
): Promise<{ data: T | null; status: number; error: string | null }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof parsed?.error === 'string' ? parsed.error : `Request failed (${response.status})`;
      return { data: parsed, status: response.status, error: message };
    }
    return { data: parsed, status: response.status, error: null };
  } catch {
    return { data: null, status: 0, error: 'Could not reach the server' };
  }
}
