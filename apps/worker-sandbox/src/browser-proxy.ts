/**
 * The egress proxy every sandbox browser connection goes through — the
 * SSRF boundary for the browser, in the same spirit as the guard
 * `sandbox_download_url` runs its one URL through, but sitting where a
 * browser's traffic actually is: a page loads dozens of sub-resources,
 * follows redirects, opens websockets, and none of that passes back
 * through a tool argument we could inspect. So Chromium is launched with
 * NO direct network access of its own — every connection is a CONNECT (or
 * a plain-http request) to this loopback listener, which resolves the host
 * itself, refuses the localhost family and every private/reserved range
 * (`assertSafeHostname` / `isBlockedIP`, the shared egress guard), and then
 * dials the very address it verified. That last step is what a
 * resolve-then-fetch check cannot promise: there is no second lookup for
 * DNS rebinding to swap the answer on.
 *
 * Deliberately tiny — no caching, no auth, no keep-alive cleverness —
 * because it listens on 127.0.0.1 inside the sandbox container and only
 * the worker's own browser process is ever pointed at it. TLS is untouched:
 * the browser does its own handshake through the tunnel, so certificate
 * validation stays exactly where Chromium keeps it.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { lookup } from 'node:dns/promises';
import net, { type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { assertSafeHostname, BlockedUrlError, isBlockedIP } from '@renkei/connector-sandbox';
import { logger } from './logger';

export interface EgressProxy {
  /** The loopback port Chromium is pointed at. */
  port: number;
  close(): Promise<void>;
}

/** Resolve a hostname to the one public address the proxy will dial, or throw BlockedUrlError. */
export type AddressResolver = (hostname: string) => Promise<string>;

export interface EgressProxyDeps {
  /** Test seam: the default resolver does a real DNS lookup and applies the guard. */
  resolve?: AddressResolver;
}

const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 120_000;

/** Ports the browser may reach: the web ports plus the unprivileged range. */
function portAllowed(port: number): boolean {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return port === 80 || port === 443 || port >= 1024;
}

/**
 * The default resolver: structural hostname rules first (which also
 * settles IP literals without touching DNS), then a lookup whose every
 * answer must be public. Refusing on ANY private answer, rather than
 * picking a public one, matches assertPublicHttpsUrl — a name that
 * resolves both ways is a rebinding setup, not a host to reach.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  assertSafeHostname(hostname);
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(bare)) return bare;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${bare}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${bare}`);
  for (const { address } of addresses) {
    if (isBlockedIP(address)) {
      throw new BlockedUrlError('host resolves to a private or reserved address');
    }
  }
  return addresses[0].address;
}

/** `host:port` from a CONNECT target, with a bracketed IPv6 host kept intact. */
function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(target.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  return { host: match[1], port };
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

export function startEgressProxy(deps: EgressProxyDeps = {}): Promise<EgressProxy> {
  const resolve = deps.resolve ?? resolvePublicAddress;

  async function verifiedTarget(
    host: string,
    port: number
  ): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    if (!portAllowed(port)) return { ok: false, reason: 'port not allowed' };
    try {
      return { ok: true, address: await resolve(host) };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof BlockedUrlError ? error.message : 'host refused',
      };
    }
  }

  // CONNECT — every https origin the browser reaches, tunnelled after the
  // target is verified. `head` is any bytes the client already sent past
  // the CONNECT line (a TLS ClientHello, typically); they belong upstream.
  function onConnect(request: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const target = splitHostPort(request.url ?? '', 443);
    if (!target) return refuse(clientSocket, 400, 'Bad Request');
    void verifiedTarget(target.host, target.port).then((verdict) => {
      if (!verdict.ok) {
        logger.info('browser egress refused CONNECT {host}:{port}: {reason}', {
          component: 'worker-sandbox/browser-proxy',
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        return refuse(clientSocket, 403, 'Forbidden');
      }
      const upstream = net.connect({ host: verdict.address, port: target.port });
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('connect timeout')));
      upstream.once('connect', () => {
        upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
        clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy());
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('error', () => {
        refuse(clientSocket, 502, 'Bad Gateway');
      });
      clientSocket.once('error', () => upstream.destroy());
      clientSocket.once('close', () => upstream.destroy());
      upstream.once('close', () => clientSocket.destroy());
    });
  }

  // Plain http:// — the browser sends the absolute URL; forward it to the
  // verified address with the original Host header, streaming both ways.
  function onRequest(request: IncomingMessage, response: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      response.writeHead(400, { connection: 'close' }).end();
      return;
    }
    if (url.protocol !== 'http:') {
      response.writeHead(403, { connection: 'close' }).end();
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    void verifiedTarget(url.hostname, port).then((verdict) => {
      if (!verdict.ok) {
        logger.info('browser egress refused {host}:{port}: {reason}', {
          component: 'worker-sandbox/browser-proxy',
          host: url.hostname,
          port,
          reason: verdict.reason,
        });
        response.writeHead(403, { connection: 'close' }).end();
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (name === 'proxy-connection' || name === 'proxy-authorization') continue;
        headers[name] = value;
      }
      headers.host = url.host;
      const upstream = httpRequest(
        {
          host: verdict.address,
          port,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          setHost: false,
          timeout: CONNECT_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      );
      upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.once('error', () => {
        if (!response.headersSent) response.writeHead(502, { connection: 'close' });
        response.end();
      });
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
    });
  }

  const server: Server = createServer(onRequest);
  server.on('connect', onConnect);
  server.on('clientError', (_error, socket) => refuse(socket, 400, 'Bad Request'));

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('egress proxy did not bind a TCP port'));
        return;
      }
      resolvePromise({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
