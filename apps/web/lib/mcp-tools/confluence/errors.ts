/**
 * Confluence API failures, as one sentence the caller can act on.
 *
 * Dependency-free on purpose: client.ts pulls @renkei/db and the grant
 * machinery, so a helper that lives there cannot be unit-tested without
 * mocking half the app. This file is the pure part.
 *
 * Confluence's two API generations disagree on the error envelope: v2
 * (`/api/v2/...`) answers `{ errors: [{ status, code, title, detail }] }`,
 * v1 (`/rest/api/...`) answers `{ statusCode, message }`. Both are read;
 * anything else (an HTML error page from a gateway, an empty body) falls
 * back to the bare status so the model still gets *something* true.
 */

/** Confluence Cloud's per-request payload ceiling, 5 MiB (CONFCLOUD-82042). */
export const CONFLUENCE_MAX_REQUEST_BYTES = 5 * 1024 * 1024;

const DETAIL_MAX_CHARS = 300;

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The human-readable message inside a Confluence error body, or '' when
 * the body carries none worth quoting.
 */
export function confluenceErrorDetail(responseBody: string): string {
  const text = responseBody.trim();
  if (!text) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page (a gateway or proxy answering for Confluence) is
    // not something to quote at a model; the status alone is more honest.
    return text.startsWith('<') ? '' : text.slice(0, DETAIL_MAX_CHARS);
  }
  const body = rec(parsed);
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const fromV2 = errors
    .map((entry) => {
      const error = rec(entry);
      const title = str(error.title);
      const detail = str(error.detail);
      return detail && detail !== title ? (title ? `${title}: ${detail}` : detail) : title;
    })
    .filter((line) => line.length > 0);
  const detail = fromV2.length > 0 ? fromV2.join('; ') : str(body.message);
  return detail.length > DETAIL_MAX_CHARS ? `${detail.slice(0, DETAIL_MAX_CHARS)}…` : detail;
}

/** One sentence for a non-2xx Confluence answer, with its own reason where it gave one. */
export function describeConfluenceError(status: number, responseBody: string): string {
  if (status === 403) {
    return (
      'Confluence refused (403) — the grant likely lacks the needed scope, or the Atlassian ' +
      'app registration is missing the permission. Reconnect Confluence after the admin fixes ' +
      'the app.'
    );
  }
  if (status === 429) return 'Confluence is rate limiting (429); try again shortly.';
  if (status === 413) {
    return (
      'Confluence refused the request as too large (413). Confluence Cloud caps a single API ' +
      `request at ${CONFLUENCE_MAX_REQUEST_BYTES} bytes (5 MB), and a page body grows several ` +
      'times over once Markdown is converted to its document format — split the content ' +
      'across pages (a parent with child pages) and try again.'
    );
  }
  const detail = confluenceErrorDetail(responseBody);
  return detail
    ? `Confluence API answered ${status}: ${detail}`
    : `Confluence API answered ${status}`;
}
