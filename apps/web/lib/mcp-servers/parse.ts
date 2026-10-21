/**
 * An admin's MCP server form, validated. Pure, so the route and its test
 * share one definition of what a server registration may be.
 */

import {
  MCP_AUTH_MODES,
  MCP_TRANSPORTS,
  checkServerUrl,
  isValidSlug,
  slugify,
  type McpAuthMode,
  type McpServer,
  type McpTransport,
} from '@renkei/connector-mcp';

export const MAX_CONTEXT_CHARS = 4000;

export interface ServerInput {
  name: string;
  slug: string | null;
  url: string;
  transport: McpTransport;
  authMode: McpAuthMode;
  context: string;
  scopes: string | null;
  clientId: string | null;
  /** A new secret to seal; null means "leave as is" unless `clearClientSecret`. */
  clientSecret: string | null;
  clearClientSecret: boolean;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseServerPayload(body: unknown): { input: ServerInput } | { error: string } {
  if (!isRecord(body)) return { error: 'Send the server as a JSON object.' };
  const name = text(body.name);
  if (!name) return { error: 'Give the server a name.' };
  if (name.length > 120) return { error: 'The name is too long (120 characters at most).' };

  const checked = checkServerUrl(text(body.url));
  if (!checked.ok) return { error: checked.reason };

  const transport = MCP_TRANSPORTS.find((t) => t === body.transport) ?? 'streamable_http';
  if (body.transport !== undefined && transport !== body.transport) {
    return { error: 'The transport must be streamable_http or sse.' };
  }
  const authMode = MCP_AUTH_MODES.find((m) => m === body.authMode) ?? 'oauth';
  if (body.authMode !== undefined && authMode !== body.authMode) {
    return { error: 'The sign-in mode must be oauth or none.' };
  }

  const rawSlug = text(body.slug);
  if (rawSlug && !isValidSlug(rawSlug)) {
    return {
      error:
        'The tool prefix must start with a letter and use only lowercase letters, digits and single underscores (32 characters at most).',
    };
  }
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  if (context.length > MAX_CONTEXT_CHARS) {
    return { error: `The context is too long (${MAX_CONTEXT_CHARS} characters at most).` };
  }

  return {
    input: {
      name,
      slug: rawSlug || null,
      url: checked.url,
      transport,
      authMode,
      context,
      scopes: text(body.scopes) || null,
      clientId: text(body.clientId) || null,
      clientSecret: text(body.clientSecret) || null,
      clearClientSecret: body.clearClientSecret === true,
      enabled: body.enabled !== false,
    },
  };
}

/** The slug a new server gets: the one typed, else derived from its name. */
export function slugFor(input: ServerInput): string | null {
  const slug = input.slug ?? slugify(input.name);
  return isValidSlug(slug) ? slug : null;
}

/** What the admin screens may know about a server: everything but the secret. */
export function serverSummary(server: McpServer) {
  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    url: server.url,
    transport: server.transport,
    authMode: server.authMode,
    context: server.context,
    scopes: server.scopes,
    clientId: server.clientId,
    hasClientSecret: server.hasClientSecret,
    enabled: server.enabled,
    discovered: server.oauth !== null,
    issuer: server.oauth?.issuer ?? null,
    supportsRegistration: Boolean(server.oauth?.registrationEndpoint),
    updatedAt: server.updatedAt.toISOString(),
  };
}

export type ServerSummary = ReturnType<typeof serverSummary>;
