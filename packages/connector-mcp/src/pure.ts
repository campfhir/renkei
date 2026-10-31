/**
 * Pure helpers for remote MCP servers: names, URL policy, the shape of the
 * MCP authorization discovery documents, and how a server's tools become the
 * tools Renkei registers. No I/O, so the web app, the delegate and tests all
 * import it freely.
 */

/** The `provider_grants.provider` a server's per-person tokens are stored under. */
export const MCP_PROVIDER_PREFIX = 'mcp:';

export function mcpProvider(serverId: string): string {
  return `${MCP_PROVIDER_PREFIX}${serverId}`;
}

/** The server id inside a grant provider, or null when it is not an MCP one. */
export function serverIdOfProvider(provider: string): string | null {
  if (!provider.startsWith(MCP_PROVIDER_PREFIX)) return null;
  const id = provider.slice(MCP_PROVIDER_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** The capability key an MCP server's tools are gated on. */
export function mcpCapabilityKey(slug: string): string {
  return `mcp-${slug}`;
}

export function slugOfCapabilityKey(key: string): string | null {
  return key.startsWith('mcp-') && key.length > 4 ? key.slice(4) : null;
}

export type McpTransport = 'streamable_http' | 'sse';
export type McpAuthMode = 'oauth' | 'none';

export const MCP_TRANSPORTS: readonly McpTransport[] = ['streamable_http', 'sse'];
export const MCP_AUTH_MODES: readonly McpAuthMode[] = ['oauth', 'none'];

export const MAX_SLUG_LENGTH = 32;

/**
 * Trim underscores from both ends by scanning, not by regex: a pattern like
 * `/_+$/` backtracks quadratically on a long run of underscores in the
 * middle of a name, and the name is typed by a person.
 */
function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 95) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 95) end -= 1;
  return value.slice(start, end);
}

/** A tool-name-safe slug from a display name: lowercase letters, digits, underscore. */
export function slugify(name: string): string {
  const joined = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return trimUnderscores(trimUnderscores(joined).slice(0, MAX_SLUG_LENGTH));
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9_]{0,31}$/.test(slug) && !slug.includes('__');
}

const TOOL_NAME_LIMIT = 64;
const SEPARATOR = '__';

/** `<slug>__<tool>`, squeezed into the 64 characters model providers allow. */
export function namespacedToolName(slug: string, toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const room = TOOL_NAME_LIMIT - slug.length - SEPARATOR.length;
  return `${slug}${SEPARATOR}${safe.slice(0, Math.max(room, 1))}`;
}

/** Splits a registered name back into its slug and the (sanitised) tool part. */
export function splitNamespacedToolName(name: string): { slug: string; tool: string } | null {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0 || at + SEPARATOR.length >= name.length) return null;
  return { slug: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The endpoint an admin typed, normalised. https only, except a loopback
 * address (a server run beside Renkei in development). No embedded
 * credentials: a secret in a URL ends up in logs and in every tool list.
 */
export function checkServerUrl(input: string): UrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'The URL must not contain a username or password.' };
  }
  if (parsed.hash) parsed.hash = '';
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))
  ) {
    return { ok: false, reason: 'The URL must use https.' };
  }
  return { ok: true, url: parsed.toString() };
}

/** Whether a URL belongs to the same origin as the server — where its token may go. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ── authorization discovery (RFC 9728 / RFC 8414 / RFC 7591) ───────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The `resource_metadata` URL a 401's WWW-Authenticate header points at. */
export function resourceMetadataFromChallenge(header: string | null): string | null {
  if (!header) return null;
  const match =
    /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^\s,]+)/i.exec(header);
  return match ? match[1] : null;
}

/** Where protected-resource metadata lives when the server did not say (RFC 9728 §3). */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const urls = [];
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** Authorization-server metadata locations, in the order the MCP spec tries them. */
export function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

export function authorizationServersOf(metadata: unknown): string[] {
  return isRecord(metadata) ? strings(metadata.authorization_servers) : [];
}

/** What discovery learned about a server's authorization server. */
export interface McpOAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopesSupported: string[];
  /** `client_secret_basic` or `client_secret_post` etc.; drives how the delegate authenticates. */
  tokenAuthMethods: string[];
  pkceMethods: string[];
}

export function parseAuthServerMetadata(
  value: unknown,
  fallbackIssuer: string
): McpOAuthMetadata | null {
  if (!isRecord(value)) return null;
  const authorizationEndpoint =
    typeof value.authorization_endpoint === 'string' ? value.authorization_endpoint : '';
  const tokenEndpoint = typeof value.token_endpoint === 'string' ? value.token_endpoint : '';
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  return {
    issuer: typeof value.issuer === 'string' ? value.issuer : fallbackIssuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof value.registration_endpoint === 'string' ? value.registration_endpoint : null,
    revocationEndpoint:
      typeof value.revocation_endpoint === 'string' ? value.revocation_endpoint : null,
    scopesSupported: strings(value.scopes_supported),
    tokenAuthMethods: strings(value.token_endpoint_auth_methods_supported),
    pkceMethods: strings(value.code_challenge_methods_supported),
  };
}

/** Parses the stored `mcp_servers.oauth` column; null when it is not metadata. */
export function readStoredOAuth(value: unknown): McpOAuthMetadata | null {
  if (!isRecord(value)) return null;
  return parseAuthServerMetadata(
    {
      issuer: value.issuer,
      authorization_endpoint: value.authorizationEndpoint,
      token_endpoint: value.tokenEndpoint,
      registration_endpoint: value.registrationEndpoint,
      revocation_endpoint: value.revocationEndpoint,
      scopes_supported: value.scopesSupported,
      token_endpoint_auth_methods_supported: value.tokenAuthMethods,
      code_challenge_methods_supported: value.pkceMethods,
    },
    typeof value.issuer === 'string' ? value.issuer : ''
  );
}

/** How the delegate should authenticate to the token endpoint. */
export function tokenClientAuth(methods: string[], hasSecret: boolean): 'none' | 'basic' | 'body' {
  if (!hasSecret) return 'none';
  if (methods.length === 0 || methods.includes('client_secret_basic')) return 'basic';
  return 'body';
}

/** The scope string to request: the admin's, else what the server advertises. */
export function scopeToRequest(configured: string | null, metadata: McpOAuthMetadata): string {
  if (configured && configured.trim()) return configured.trim();
  return metadata.scopesSupported.join(' ');
}

// ── tools ──────────────────────────────────────────────────────────────────

/** A tool as a server listed it, trimmed to what registration needs. */
export interface McpListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True only for an explicit `readOnlyHint: true`; anything else is an act. */
  readOnly: boolean;
}

/**
 * A remote server writes its own tool descriptions, and a description goes
 * into every model's context that can see the tool: bounded, so a hostile or
 * careless server cannot spend the window or bury an instruction in a wall
 * of text.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 2_000;

function clipDescription(text: string): string {
  return text.length > MAX_TOOL_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`
    : text;
}

export function parseListedTool(value: unknown): McpListedTool | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
  const schema = isRecord(value.inputSchema) ? value.inputSchema : { type: 'object' };
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  const title = typeof annotations.title === 'string' ? annotations.title : '';
  const description = typeof value.description === 'string' ? value.description : title;
  return {
    name: value.name,
    description: clipDescription(description),
    inputSchema: schema,
    readOnly: annotations.readOnlyHint === true,
  };
}

/**
 * A tool as it was cached: the already-trimmed `McpListedTool` shape, which
 * is NOT the wire shape `parseListedTool` reads (there `readOnly` is
 * `annotations.readOnlyHint`). Only an explicit `true` stays a read.
 */
export function parseStoredTool(value: unknown): McpListedTool | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
  return {
    name: value.name,
    description: typeof value.description === 'string' ? clipDescription(value.description) : '',
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : { type: 'object' },
    readOnly: value.readOnly === true,
  };
}

export function parseStoredTools(value: unknown): McpListedTool[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseStoredTool).filter((t): t is McpListedTool => t !== null);
}

/** Cached tool lists older than this are refreshed in the background. */
export const TOOL_LIST_TTL_MS = 15 * 60_000;
