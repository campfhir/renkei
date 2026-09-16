/**
 * The Mirth REST API's shape, as far as Renkei needs to know it: how a base
 * URL is normalized, which request paths are acceptable to forward, which
 * operations count as destructive, and how the XStream-flavoured JSON the
 * server answers with is unwrapped into plain arrays and maps.
 *
 * Everything here is pure and dependency-free so it can run in the worker
 * (which forwards the requests), the web app's tools (which phrase them),
 * and client components alike, and be tested without a server.
 */

/** Every Mirth REST route lives under this prefix on the server. */
export const MIRTH_API_PREFIX = '/api';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export function isHttpMethod(value: unknown): value is HttpMethod {
  return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE';
}

/**
 * Parse an operator-supplied server URL. HTTPS is required unless the
 * operator has explicitly recorded `allowInsecureHttp` — a lab server on
 * plain 8080 exists, but sending a Mirth password over plaintext must be a
 * decision, not a default. Credentials, query strings and fragments in the
 * URL are refused; the result is origin + path with no trailing slash.
 */
export function parseBaseUrl(value: unknown, allowInsecureHttp: boolean): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  // Operators often paste the API root itself; the prefix is added per
  // request, so strip it here rather than end up at /api/api.
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return url.origin + path;
}

/**
 * The one path filter between a caller and the Mirth server. Paths are API
 * routes relative to `/api` (`/channels`, `/server/version`): absolute,
 * never climbing, never a second URL, and never a query string — query
 * parameters travel separately so they are encoded exactly once.
 */
export function validApiPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  if (path.length > 2048) return false;
  if (path.includes('..') || path.includes('://') || path.startsWith('//')) return false;
  if (path.includes('?') || path.includes('#')) return false;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Whether an API request is destructive — permanent on the Mirth side, or
 * wide enough that a person should have opted in separately. The list is
 * deliberately conservative in the widening direction: anything DELETE, and
 * the POST/PUT routes that remove data, purge stores, replace a whole
 * server's configuration, install or uninstall an extension, run a
 * database task, or clear statistics. Deploying, undeploying, starting and
 * stopping channels are reversible and stay ordinary writes.
 */
const DESTRUCTIVE_WRITE_PATTERNS: RegExp[] = [
  /^\/channels\/_removeChannels$/,
  /^\/channels\/[^/]+\/messages\/_remove$/,
  /^\/channels\/_removeAllMessagesPost$/,
  /^\/channels\/[^/]+\/messages\/_importFromPath$/,
  /^\/channels\/_clearStatistics$/,
  /^\/channels\/_clearAllStatistics$/,
  /^\/server\/configuration$/,
  /^\/extensions\/_uninstall$/,
  /^\/extensions\/_install$/,
  /^\/codeTemplateLibraries\/_bulkUpdate$/,
  /^\/channelgroups\/_bulkUpdate$/,
  /^\/databaseTasks\/[^/]+\/_run$/,
  /^\/users\/[^/]+\/password$/,
];

export function isDestructiveRequest(method: HttpMethod, path: string): boolean {
  if (method === 'DELETE') return true;
  if (method === 'GET') return false;
  return DESTRUCTIVE_WRITE_PATTERNS.some((pattern) => pattern.test(path));
}

// ---------------------------------------------------------------------------
// XStream JSON unwrapping.
//
// Mirth serializes with XStream, whose JSON dialect wraps a Java List as
// `{"list": {"channel": [...]}}`, a Map as `{"map": {"entry": [...]}}` with
// each entry either `{"string": ["k", "v"]}` (homogeneous) or
// `{"string": "k", "<type>": v}` (mixed), and a Set as `{"set": {...}}`.
// Worse, a single element is emitted as an object rather than a one-item
// array. These helpers normalize all of that so a tool can reason about
// plain arrays and records.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One element or an array of them, as an array; null/undefined/'' as empty. */
export function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The elements of an XStream list/set envelope, whatever the element tag
 * (`channel`, `dashboardStatus`, `string`…). A bare array passes through;
 * an empty envelope (`{"list": ""}` / `{"list": null}`) is empty.
 */
export function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const envelope = ['list', 'set', 'linked-list', 'sorted-set', 'linked-hash-set'].find(
    (key) => key in value
  );
  const inner = envelope === undefined ? value : value[envelope];
  if (!isRecord(inner)) return [];
  if (envelope === undefined && Object.keys(inner).length !== 1) return [];
  return Object.values(inner).flatMap((element) => asArray(element));
}

/**
 * An XStream map envelope as a plain record. Entries of a `Map<String,
 * String>` arrive as `{"string": ["k", "v"]}`; mixed maps as
 * `{"string": "k", "<type>": v}`; empty as `{"map": ""}`.
 */
export function unwrapMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const envelope = ['map', 'linked-hash-map', 'tree-map', 'concurrent-hash-map'].find(
    (key) => key in value
  );
  const inner = envelope === undefined ? value : value[envelope];
  if (!isRecord(inner)) return {};
  const result: Record<string, unknown> = {};
  for (const entry of asArray(inner.entry)) {
    if (!isRecord(entry)) continue;
    const keys = Object.keys(entry);
    if (keys.length === 1 && Array.isArray(entry[keys[0]])) {
      const pair = entry[keys[0]];
      if (Array.isArray(pair) && pair.length >= 1) result[String(pair[0])] = pair[1] ?? null;
      continue;
    }
    // Mixed: XStream writes the key first and the value second, whatever
    // their types ({"int": 0, "string": "sourceConnector"} is 0 → name), and
    // JSON.parse keeps that order.
    if (keys.length < 1) continue;
    const key = entry[keys[0]];
    if (typeof key !== 'string' && typeof key !== 'number') continue;
    result[String(key)] = keys.length > 1 ? entry[keys[1]] : null;
  }
  return result;
}

/** Text of a value, for the model: strings as-is, everything else JSON. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
