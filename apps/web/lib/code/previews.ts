/**
 * A code project's previews as the web app sees them: a server a chat
 * (or a person, from the project's routes) started in a checkout, which
 * the sandbox worker keeps running on ports from its pool and this app
 * serves to a browser — `/api/code/projects/[projectId]/previews/[name]/app/…`
 * for the first port and `…/previews/[name]/ports/[port]/…` for any named
 * one, for a signed-in member; `/api/code/preview/[token]/…` for anyone
 * holding the share link a public preview's port was started with. All
 * relay the request to the worker's proxy (previewRelay) and the answer
 * back as it streams.
 *
 * Share tokens are minted HERE, one per port, not on the worker, because
 * the addresses go into the start request (the process is told where
 * each port is served, RENKEI_PREVIEW_URL and RENKEI_PREVIEW_URL_<NAME>):
 * 32 random bytes each, the whole secret of a link, revoked by stopping
 * the preview and gone when it expires.
 */

import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  PREVIEW_TOKEN_BYTES,
  previewProxyPath,
  proxyResponseHeaders,
  publicPreviewPath,
  stripCookies,
  stripHopByHop,
  validateCommand,
  validatePreviewName,
  validatePreviewPorts,
} from '@renkei/connector-sandbox';
import {
  sbPreviewProxyTarget,
  type PreviewPortRequest,
  type WirePreview,
  type WirePreviewPort,
} from '@renkei/sandbox-client';
import { sessionCookieName } from '@/lib/session';
import {
  hostMemberPath,
  hostTokenPath,
  previewHostBase,
  PREVIEW_SESSION_COOKIE,
} from './preview-host';

export interface PreviewsView {
  previews: WirePreview[];
}

export interface PreviewStartInput {
  name: string;
  command: string;
  /** The port names, first one primary; `['app']` when none were given. */
  ports: string[];
  public: boolean;
  waitMs?: number;
}

/** A start from a page or a tool: a name, a command, the ports by name, public or not. */
export function parsePreviewStartPayload(body: unknown): PreviewStartInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: {
    name?: unknown;
    command?: unknown;
    ports?: unknown;
    public?: unknown;
    waitSeconds?: unknown;
  } = body;
  const name = validatePreviewName(record.name);
  if (!name.ok) return { error: name.message };
  const command = validateCommand(record.command);
  if (!command.ok) return { error: command.message };
  const ports = validatePreviewPorts(record.ports);
  if (!ports.ok) return { error: ports.message };
  const waitSeconds =
    typeof record.waitSeconds === 'number' && Number.isFinite(record.waitSeconds)
      ? record.waitSeconds
      : undefined;
  return {
    name: name.name,
    command: command.command,
    ports: ports.ports,
    public: record.public === true,
    ...(waitSeconds !== undefined ? { waitMs: Math.round(waitSeconds * 1000) } : {}),
  };
}

export function mintPreviewToken(): string {
  return randomBytes(PREVIEW_TOKEN_BYTES).toString('base64url');
}

export interface PreviewPortAddress {
  name: string;
  /** The member's address for this port. */
  url: string;
  /** The share link, when the port has a token. */
  publicUrl: string | null;
  token: string | null;
}

export interface PreviewAddresses {
  /** The first port's member address. */
  url: string;
  /** The first port's share link, when public. */
  publicUrl: string | null;
  ports: PreviewPortAddress[];
}

/**
 * The addresses a preview's ports are served at: each port's member
 * address (the first port's is the `app/` one), and its share link when
 * it has a token. Tokens come in with the ports — minted here before a
 * start, or as the worker holds them for a listing.
 */
export function previewAddresses(
  origin: string,
  input: {
    projectId: string;
    chatId: string | null;
    name: string;
    ports: ReadonlyArray<{ name: string; token: string | null }>;
  },
  /** The organization's preview host (preview-host.ts); '' serves previews on the app's origin. */
  previewHost = ''
): PreviewAddresses {
  const base = previewHost ? previewHostBase(previewHost) : origin.replace(/\/$/, '');
  const ports = input.ports.map((port, index) => {
    const ref = {
      projectId: input.projectId,
      chatId: input.chatId,
      name: input.name,
      ...(index === 0 ? {} : { port: port.name }),
    };
    const publicPath = port.token
      ? previewHost
        ? hostTokenPath(port.token)
        : publicPreviewPath(port.token)
      : null;
    return {
      name: port.name,
      url: `${base}${previewHost ? hostMemberPath(ref) : previewProxyPath(ref)}`,
      publicUrl: publicPath ? `${base}${publicPath}` : null,
      token: port.token,
    };
  });
  return { url: ports[0]?.url ?? '', publicUrl: ports[0]?.publicUrl ?? null, ports };
}

/** The ports a start sends the worker: each name with where it is served (the public address when it has a token). */
export function previewPortRequests(addresses: PreviewAddresses): PreviewPortRequest[] {
  return addresses.ports.map((port) => ({
    name: port.name,
    url: port.publicUrl ?? port.url,
    ...(port.token ? { token: port.token } : {}),
  }));
}

/** A preview as a listing answers it: each port with the member address and share link this app serves it at. */
export type ListedPreview = Omit<WirePreview, 'ports'> & {
  url: string;
  publicUrl: string | null;
  ports: Array<WirePreviewPort & { publicUrl: string | null }>;
};

/**
 * Where a member's click on a preview goes when sandboxes are
 * orchestrated: this app's own `open` route (previews/[name]/open), which
 * knows who is signed in and sends the browser on — straight to the
 * sandbox's port where the platform can let that person in as themselves,
 * else to the relay below as always. The link carries no identity: the
 * route reads it from the session.
 */
export function previewOpenPath(input: {
  projectId: string;
  chatId?: string | null;
  name: string;
  /** A named port; absent means the first. */
  port?: string | null;
}): string {
  const chat = input.chatId ? `/chats/${input.chatId}` : '';
  const query = input.port ? `?port=${encodeURIComponent(input.port)}` : '';
  return `/api/code/projects/${input.projectId}${chat}/previews/${input.name}/open${query}`;
}

/**
 * The port of a listed preview a click means: the one named, else the
 * first — with the path the relay serves it at. Null when the preview
 * has no such port.
 */
export function previewPortToOpen(
  preview: WirePreview,
  scope: { projectId: string; chatId: string | null },
  portName: string | null
): { port: number; relayPath: string } | null {
  const index = portName ? preview.ports.findIndex((port) => port.name === portName) : 0;
  const found = preview.ports[index];
  if (!found) return null;
  return {
    port: found.port,
    relayPath: previewProxyPath({
      ...scope,
      name: preview.name,
      ...(index === 0 ? {} : { port: found.name }),
    }),
  };
}

export function withAddresses(
  preview: WirePreview,
  origin: string,
  scope: { projectId: string; chatId: string | null },
  previewHost = '',
  /**
   * Send a member's click through the `open` route (orchestrated
   * sandboxes, previews served on this app's own origin).
   */
  throughOpen = false
): ListedPreview {
  const addresses = previewAddresses(
    origin,
    {
      ...scope,
      name: preview.name,
      ports: preview.ports,
    },
    previewHost
  );
  const base = origin.replace(/\/$/, '');
  const memberUrl = (index: number): string | undefined =>
    throughOpen && !previewHost
      ? `${base}${previewOpenPath({
          ...scope,
          name: preview.name,
          ...(index === 0 ? {} : { port: preview.ports[index]?.name ?? null }),
        })}`
      : addresses.ports[index]?.url;
  return {
    ...preview,
    url: memberUrl(0) ?? addresses.url,
    publicUrl: addresses.publicUrl,
    ports: preview.ports.map((port, index) => ({
      ...port,
      url: memberUrl(index) ?? port.url,
      publicUrl: addresses.ports[index]?.publicUrl ?? null,
    })),
  };
}

/** Statuses that must carry no body, which the Response constructor refuses to pair with one. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The web app's own cookies. A preview runs a repository's or a model's
 * code, so it is neither sent these nor allowed to set them: the session,
 * the sign-in and connect-flow state, and the preview host's own session
 * (preview-host.ts).
 */
function isAppCookie(name: string): boolean {
  return (
    name === sessionCookieName() ||
    name === PREVIEW_SESSION_COOKIE ||
    name.startsWith('oidc_') ||
    name.startsWith('connect_state_')
  );
}

/** A `cookie` header without the app's own cookies; empty when nothing is left. */
function withoutAppCookies(cookieHeader: string): string {
  const names = cookieHeader
    .split(';')
    .map((pair) => pair.trim().split('=')[0]?.trim() ?? '')
    .filter(isAppCookie);
  return stripCookies(cookieHeader, names);
}

/**
 * One browser request relayed to a preview's port through the worker and
 * the answer streamed back. The web app's own session cookie never goes
 * along (the preview runs the project's own code), hop-by-hop headers
 * stop here, the worker is asked for identity encoding so what it relays
 * is what the browser gets, and a redirect to a path on the server is
 * rewritten under the port's prefix so it lands back inside it. `path`
 * is what followed the prefix; the query string rides as it came.
 */
export async function previewRelay(
  request: NextRequest,
  ref: { subject: string; name: string; port?: string | null } | { token: string },
  options: { prefix: string; path: string[] | undefined }
): Promise<Response> {
  // The path the browser asked for, segment by segment: each one encoded,
  // none of them a dot segment, so the relayed path can only descend from
  // the preview's own prefix on the worker — never climb to another verb.
  const segments = options.path ?? [];
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return Response.json({ error: 'Not a preview path.', code: 'not-found' }, { status: 404 });
  }
  const rest = segments.map(encodeURIComponent).join('/') + request.nextUrl.search;
  const target = await sbPreviewProxyTarget(ref, rest);
  if (!target) {
    return Response.json(
      { error: 'The sandbox scratch space is not configured on this deployment.', code: 'sandbox' },
      { status: 503 }
    );
  }
  const incoming = stripHopByHop(Object.fromEntries(request.headers.entries()));
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (name === 'authorization' || name === 'x-sandbox-subject') continue;
    if (name === 'cookie') {
      const kept = withoutAppCookies(String(value));
      if (kept) headers.set('cookie', kept);
      continue;
    }
    if (name === 'content-length' || name === 'accept-encoding') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) headers.set('x-forwarded-host', host);
  headers.set(
    'x-forwarded-proto',
    request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '')
  );
  headers.set('x-forwarded-prefix', options.prefix.replace(/\/$/, ''));
  for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // `duplex` is what a streamed request body needs from Node's fetch; the
  // DOM's RequestInit type does not know it yet.
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = 'half';
  }
  let upstream: Response;
  try {
    // A reverse proxy is the feature: the host is the deployment's own
    // sandbox worker (SANDBOX_WORKER_URL, never the request's), the prefix
    // names the preview, and only the path and query below it are the
    // browser's — encoded, no dot segments — which is what a proxy relays.
    // codeql[js/request-forgery]
    upstream = await fetch(target.url, init);
  } catch (error) {
    return Response.json(
      {
        error: `Could not reach the sandbox service for the preview: ${error instanceof Error ? error.message : String(error)}`,
        code: 'sandbox',
      },
      { status: 502 }
    );
  }
  const outgoing = proxyResponseHeaders(
    Object.fromEntries(upstream.headers.entries()),
    options.prefix
  );
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(outgoing)) {
    if (name === 'content-length' || name === 'content-encoding') continue;
    // Cookies are set one header each, below, and never the app's own.
    if (name === 'set-cookie') continue;
    responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    if (!isAppCookie(cookie.slice(0, cookie.indexOf('=')).trim())) {
      responseHeaders.append('set-cookie', cookie);
    }
  }
  responseHeaders.set('cache-control', 'no-store');
  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
