/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The egress proxy's own contract, driven with real sockets against real
 * local listeners: a CONNECT or plain-http request to a refused host is
 * answered with 403 and never dialled; a verified host is dialled at the
 * address the resolver returned (not re-resolved), with the tunnel and the
 * forwarded request both carrying bytes faithfully; privileged ports other
 * than 80/443 are refused outright.
 */

import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { BlockedUrlError } from '@renkei/connector-sandbox';
import { resolvePublicAddress, startEgressProxy, type EgressProxy } from './browser-proxy';

let origin: Server;
let originPort: number;
let proxy: EgressProxy;
const resolved: string[] = [];

beforeAll(async () => {
  origin = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/plain',
      'x-seen-host': request.headers.host ?? '',
    });
    response.end(`origin saw ${request.method} ${request.url}`);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as AddressInfo).port;
  proxy = await startEgressProxy({
    resolve: async (host) => {
      resolved.push(host);
      // The one name the tests are allowed to reach — mapped to the local
      // origin, standing in for "a public address the guard accepted".
      if (host === 'allowed.test') return '127.0.0.1';
      return resolvePublicAddress(host);
    },
  });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

beforeEach(() => {
  resolved.length = 0;
});

/** Send one raw request to the proxy and collect the whole reply. */
function rawExchange(payload: string, waitMs = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
    socket.on('connect', () => {
      socket.write(payload);
      setTimeout(() => socket.end(), waitMs);
    });
  });
}

describe('CONNECT', () => {
  it('refuses a loopback literal with 403 before dialling anything', async () => {
    const reply = await rawExchange(
      `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`
    );
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('refuses the localhost family and private ranges', async () => {
    for (const target of [
      'localhost:443',
      'app.localhost:443',
      '10.0.0.5:443',
      '[::1]:443',
      '169.254.169.254:80',
    ]) {
      const reply = await rawExchange(`CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
    }
  });

  it('refuses privileged ports other than 80 and 443', async () => {
    const reply = await rawExchange(
      'CONNECT allowed.test:25 HTTP/1.1\r\nHost: allowed.test\r\n\r\n'
    );
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
    expect(resolved).toEqual([]);
  });

  it('tunnels a verified target to the resolved address, forwarding early bytes', async () => {
    const request = `GET /tunnelled HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`;
    const reply = await rawExchange(
      `CONNECT allowed.test:${originPort} HTTP/1.1\r\nHost: allowed.test\r\n\r\n${request}`,
      400
    );
    expect(reply.startsWith('HTTP/1.1 200 Connection Established')).toBe(true);
    expect(reply).toContain('origin saw GET /tunnelled');
    expect(resolved).toEqual(['allowed.test']);
  });

  it('answers 502 when the verified address does not accept the connection', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const reply = await rawExchange(
      `CONNECT allowed.test:${deadPort} HTTP/1.1\r\nHost: allowed.test\r\n\r\n`,
      400
    );
    expect(reply.startsWith('HTTP/1.1 502')).toBe(true);
  });
});

describe('plain http', () => {
  it('forwards an absolute-URL request to the resolved address with the original Host', async () => {
    // fetch cannot send a proxy-style absolute request line, so the
    // exchange is driven over a raw socket.
    const reply = await rawExchange(
      `GET http://allowed.test:${originPort}/forwarded?x=1 HTTP/1.1\r\nHost: allowed.test:${originPort}\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`,
      400
    );
    expect(reply).toContain('HTTP/1.1 200');
    expect(reply).toContain('origin saw GET /forwarded?x=1');
    expect(reply).toContain(`x-seen-host: allowed.test:${originPort}`);
  });

  it('refuses a private host with 403 and never dials it', async () => {
    const reply = await rawExchange(
      `GET http://127.0.0.1:${originPort}/secret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      300
    );
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
    expect(reply).not.toContain('origin saw');
  });

  it('refuses a non-http scheme in the request line', async () => {
    const reply = await rawExchange(
      `GET ftp://allowed.test/file HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`
    );
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('answers a relative request line (not a proxy request) with 400', async () => {
    const reply = await rawExchange(
      `GET /not-absolute HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`
    );
    expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
  });
});

describe('resolvePublicAddress', () => {
  it('settles IP literals structurally, without DNS', async () => {
    await expect(resolvePublicAddress('93.184.216.34')).resolves.toBe('93.184.216.34');
    await expect(resolvePublicAddress('[2001:db8::1]')).resolves.toBe('2001:db8::1');
    await expect(resolvePublicAddress('192.168.1.1')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(resolvePublicAddress('localhost')).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
