/* eslint-disable @typescript-eslint/consistent-type-assertions -- server.address() is typed AddressInfo | string | null; a listening TCP server always gives the object form. */
/**
 * dialUpstream's own contract, against a real socket rather than the
 * injected mock server.test.ts uses: the timeout, the too_large cutoff,
 * and — the thing that actually reproduces a real bug report — that
 * `readBody: false` resolves from the status line alone and can NEVER
 * fail 'too_large', no matter how much the far end keeps sending. A real
 * ADManager Plus instance answered its reachability probe with more than
 * MAX_UPSTREAM_BYTES of body before this existed, and the probe failed
 * as unreachable even though the server plainly was — this is the fix.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { dialUpstream, type TlsPolicy } from './upstream';

const TLS: TlsPolicy = { verify: false };

let server: Server;
let base: string;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<void> {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('dialUpstream', () => {
  it('buffers a normal response and reports its status/body', async () => {
    await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    const result = await dialUpstream({
      url: base,
      method: 'GET',
      headers: {},
      tls: TLS,
      timeoutMs: 2000,
      maxBodyBytes: 1024,
    });
    if ('failed' in result) throw new Error(`expected success, got ${result.failed}`);
    expect(result.status).toBe(200);
    expect(result.body.toString('utf8')).toBe('hello');
  });

  it('fails too_large when the body exceeds the cap and readBody is left on', async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(2048));
    });
    const result = await dialUpstream({
      url: base,
      method: 'GET',
      headers: {},
      tls: TLS,
      timeoutMs: 2000,
      maxBodyBytes: 1024,
    });
    expect(result).toMatchObject({ failed: 'too_large' });
  });

  it('readBody: false succeeds on status alone, even past the byte cap — the reported bug', async () => {
    await serve((_req, res) => {
      // Far more than maxBodyBytes below — this is what a large org's
      // listDomains answer looks like, and it must never be why a
      // reachable server gets reported as unreachable.
      res.writeHead(401);
      res.end('x'.repeat(8 * 1024 * 1024));
    });
    const result = await dialUpstream({
      url: base,
      method: 'GET',
      headers: {},
      tls: TLS,
      timeoutMs: 2000,
      maxBodyBytes: 1024,
      readBody: false,
    });
    if ('failed' in result) throw new Error(`expected success, got ${result.failed}: ${result.detail}`);
    expect(result.status).toBe(401);
    expect(result.body.byteLength).toBe(0);
  });

  it('readBody: false still resolves the real status for a small, ordinary answer', async () => {
    await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const result = await dialUpstream({
      url: base,
      method: 'GET',
      headers: {},
      tls: TLS,
      timeoutMs: 2000,
      maxBodyBytes: 1024,
      readBody: false,
    });
    if ('failed' in result) throw new Error(`expected success, got ${result.failed}`);
    expect(result.status).toBe(200);
  });

  it('still fails on a genuine timeout regardless of readBody', async () => {
    await serve(() => {
      // Never respond.
    });
    const result = await dialUpstream({
      url: base,
      method: 'GET',
      headers: {},
      tls: TLS,
      timeoutMs: 50,
      maxBodyBytes: 1024,
      readBody: false,
    });
    expect(result).toMatchObject({ failed: 'timeout' });
  });
});
