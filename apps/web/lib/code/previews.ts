/**
 * A code project's previews as the web app sees them: a server a chat
 * (or a person, from the project's routes) started in a checkout, which
 * the sandbox worker keeps running and this app serves to a browser —
 * `/api/code/projects/[projectId]/previews/[name]/app/…` for a signed-in
 * member, `/api/code/preview/[token]/…` for anyone holding the share link
 * a public preview was started with. Both relay the request to the
 * worker's proxy (previewRelay) and the answer back as it streams.
 *
 * The share token is minted HERE, not on the worker, because the public
 * address goes into the start request (the process is told where it is
 * served, RENKEI_PREVIEW_URL): 32 random bytes, the whole secret of the
 * link, revoked by stopping the preview and gone when it expires.
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
  validatePreviewPort,
} from '@renkei/connector-sandbox';
import { sbPreviewProxyTarget, type WirePreview } from '@renkei/sandbox-client';
import { sessionCookieName } from '@/lib/session';

export interface PreviewsView {
  previews: WirePreview[];
}

export interface PreviewStartInput {
  name: string;
  command: string;
  port?: number;
  public: boolean;
  waitMs?: number;
}

/** A start from a page or a tool: a name, a command, an optional fixed port, public or not. */
export function parsePreviewStartPayload(body: unknown): PreviewStartInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: {
    name?: unknown;
    command?: unknown;
    port?: unknown;
    public?: unknown;
    waitSeconds?: unknown;
  } = body;
  const name = validatePreviewName(record.name);
  if (!name.ok) return { error: name.message };
  const command = validateCommand(record.command);
  if (!command.ok) return { error: command.message };
  const port = validatePreviewPort(record.port);
  if (!port.ok) return { error: port.message };
  const waitSeconds =
    typeof record.waitSeconds === 'number' && Number.isFinite(record.waitSeconds)
      ? record.waitSeconds
      : undefined;
  return {
    name: name.name,
    command: command.command,
    ...(port.port !== null ? { port: port.port } : {}),
    public: record.public === true,
    ...(waitSeconds !== undefined ? { waitMs: Math.round(waitSeconds * 1000) } : {}),
  };
}

export function mintPreviewToken(): string {
  return randomBytes(PREVIEW_TOKEN_BYTES).toString('base64url');
}

/** The addresses a preview is served at: the member's, and the public one when it has a token. */
export function previewAddresses(
  origin: string,
  input: { projectId: string; chatId: string | null; name: string; token: string | null }
): { url: string; publicUrl: string | null } {
  const base = origin.replace(/\/$/, '');
  return {
    url: `${base}${previewProxyPath(input)}`,
    publicUrl: input.token ? `${base}${publicPreviewPath(input.token)}` : null,
  };
}

/** Statuses that must carry no body, which the Response constructor refuses to pair with one. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * One browser request relayed to a preview through the worker and the
 * answer streamed back. The web app's own session cookie never goes
 * along (the preview runs the project's own code), hop-by-hop headers
 * stop here, the worker is asked for identity encoding so what it
 * relays is what the browser gets, and a redirect to a path on the
 * server is rewritten under the preview's prefix so it lands back
 * inside it. `path` is what followed the prefix; the query string rides
 * as it came.
 */
export async function previewRelay(
  request: NextRequest,
  ref: { subject: string; name: string } | { token: string },
  options: { prefix: string; path: string[] | undefined }
): Promise<Response> {
  const rest = (options.path ?? []).map(encodeURIComponent).join('/') + request.nextUrl.search;
  const target = sbPreviewProxyTarget(ref, rest);
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
      const kept = stripCookies(String(value), [sessionCookieName()]);
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
    responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  responseHeaders.set('cache-control', 'no-store');
  return new Response(NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
