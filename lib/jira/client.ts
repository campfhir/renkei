/**
 * The only way Renkei talks to Jira.
 *
 * The allowlist check lives here rather than in the tool handlers on purpose:
 * a tool cannot reach an endpoint by forgetting to check, and adding a tool
 * later cannot widen the surface without also editing the allowlist. That
 * matters more than usual here, because the granted OAuth scopes reach far
 * more than the tool surface — see MUST_NEVER_ALLOW in ./allowlist.ts.
 */

import { ATLASSIAN_API_BASE, type FetchLike } from '../auth/atlassian.js';
import { isAllowedJiraEndpoint, type HttpMethod } from './allowlist.js';
import { withRetry, HttpRetryableError, isTransientHttpStatus } from '../util/retry.js';

export class EndpointNotAllowedError extends Error {
  readonly method: HttpMethod;
  readonly path: string;

  constructor(method: HttpMethod, path: string) {
    super(`${method} ${path} is not in the Jira endpoint allowlist`);
    this.name = 'EndpointNotAllowedError';
    this.method = method;
    this.path = path;
  }
}

export class JiraApiError extends Error {
  readonly status: number;
  readonly method: HttpMethod;
  readonly path: string;
  readonly isTransient: boolean;
  readonly isAuthError: boolean;

  constructor(method: HttpMethod, path: string, status: number, detail: string) {
    const isTransient = isTransientHttpStatus(status);
    const isAuthError = status === 401;
    let message = `Jira ${method} ${path} failed with HTTP ${status}`;

    if (isAuthError) {
      message += ': token invalid or expired — please re-authenticate by running `pnpm auth`';
    } else if (isTransient) {
      message += `: ${detail} (transient, will retry)`;
    } else if (detail) {
      message += `: ${detail}`;
    }

    super(message);
    this.name = 'JiraApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.isTransient = isTransient;
    this.isAuthError = isAuthError;
  }
}

export interface JiraClientOptions {
  cloudId: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: FetchLike;
  apiBase?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * A `multipart/form-data` body, for the two attachment upload endpoints.
   * Mutually exclusive with `body`; the content type is left unset so the
   * runtime can generate the boundary.
   */
  form?: FormData;
}

export class JiraClient {
  readonly #cloudId: string;
  readonly #getAccessToken: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #apiBase: string;

  constructor(options: JiraClientOptions) {
    this.#cloudId = options.cloudId;
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#apiBase = options.apiBase ?? ATLASSIAN_API_BASE;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  put<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Uploads a file. Separate from `post` because Jira guards both attachment
   * endpoints with an XSRF check that only a `no-check` token satisfies, and
   * because the body must not be JSON-serialized.
   */
  postMultipart<T>(path: string, form: FormData, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, form });
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    assertWellFormedPath(method, path);

    if (!isAllowedJiraEndpoint(method, path)) {
      throw new EndpointNotAllowedError(method, path);
    }

    return withRetry(
      async () => {
        const url = new URL(`/ex/jira/${this.#cloudId}${path}`, this.#apiBase);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          if (value !== undefined) {
            url.searchParams.set(key, String(value));
          }
        }

        const accessToken = await this.#getAccessToken();
        const hasForm = options.form !== undefined;
        const hasBody = options.body !== undefined;

        if (hasForm && hasBody) {
          throw new Error(`${method} ${path}: pass either body or form, not both`);
        }

        const response = await this.#fetch(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(path.startsWith('/rest/servicedeskapi/') ? { 'X-ExperimentalApi': 'opt-in' } : {}),
            ...(hasForm ? { 'X-Atlassian-Token': 'no-check' } : {}),
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
          },
          ...(hasForm ? { body: options.form } : {}),
          ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        });

        if (!response.ok) {
          const detail = await describeFailure(response);
          const error = new JiraApiError(method, path, response.status, detail);

          if (error.isTransient || error.isAuthError) {
            throw new HttpRetryableError(response.status, error.message);
          }

          throw error;
        }

        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      },
      { maxAttempts: 3, initialDelayMs: 100 },
    );
  }
}

/**
 * The three REST surfaces Renkei speaks: the Jira platform API, the Jira
 * Service Management API, and the Jira Software API (for sprints). A path
 * outside all three is rejected before the allowlist is consulted, so a typo
 * cannot reach some third Atlassian product that the granted token also
 * happens to cover.
 */
const API_PREFIXES = ['/rest/api/3/', '/rest/servicedeskapi/', '/rest/agile/1.0/'] as const;

/**
 * Rejects anything the allowlist matcher was not designed to reason about.
 * Query strings belong in `options.query`; a `?` or `#` inside `path` would
 * otherwise be matched as part of a segment and could smuggle a different
 * effective URL past the check.
 *
 * Note `/rest/servicedeskapi/request` is a legitimate collection endpoint, so
 * the prefix check accepts the bare prefix without a trailing segment — the
 * allowlist, not this function, decides whether that path is permitted.
 */
function assertWellFormedPath(method: HttpMethod, path: string): void {
  const onKnownSurface = API_PREFIXES.some(
    (prefix) => path.startsWith(prefix) || path === prefix.slice(0, -1),
  );

  const malformed =
    !onKnownSurface ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('//') ||
    path.split('/').includes('..') ||
    path.split('/').includes('.');

  if (malformed) {
    throw new EndpointNotAllowedError(method, path);
  }
}

/**
 * Turns a Jira error response into a short, safe message. Jira echoes field
 * values in validation errors, so only the documented error arrays are read —
 * never the whole body.
 */
async function describeFailure(response: Response): Promise<string> {
  if (response.status === 401) {
    return 'token rejected — re-run `pnpm auth`';
  }

  const payload: unknown = await response.json().catch(() => null);

  if (typeof payload !== 'object' || payload === null) {
    return '';
  }

  const record = payload as { errorMessages?: unknown; errors?: unknown };
  const messages: string[] = [];

  if (Array.isArray(record.errorMessages)) {
    messages.push(...record.errorMessages.map(String));
  }
  if (typeof record.errors === 'object' && record.errors !== null) {
    for (const [field, message] of Object.entries(record.errors)) {
      messages.push(`${field}: ${String(message)}`);
    }
  }

  return messages.join('; ').slice(0, 500);
}
