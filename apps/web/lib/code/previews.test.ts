/**
 * The relay between a browser and a preview's server: the request goes
 * to the worker's proxy path for the member (subject in a header) or the
 * share token, without the app's own session cookie and without
 * hop-by-hop headers, asking for identity encoding and saying where it
 * came from; the answer comes back with a path redirect rewritten under
 * the preview's prefix, and a body-less status without a body. And the
 * start payload a page or a tool sends, read into what the worker takes.
 */

jest.mock('@/lib/session', () => ({ sessionCookieName: () => 'renkei_session' }));

import { NextRequest } from 'next/server';
import {
  mintPreviewToken,
  parsePreviewStartPayload,
  previewAddresses,
  previewPortRequests,
  previewRelay,
} from './previews';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SANDBOX_WORKER_URL: 'http://sandbox.internal:8092',
    SANDBOX_WORKER_API_KEY: 'test-key',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe('previewRelay', () => {
  it('relays a member’s request to the worker without the session cookie, and brings the answer back', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<h1>hi</h1>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '11',
          'set-cookie': 'app=1; Path=/',
          connection: 'keep-alive',
        },
      })
    );
    const request = new NextRequest(
      'https://r.example/api/code/projects/p1/chats/c1/previews/web/app/page/a?x=1',
      {
        method: 'POST',
        headers: {
          cookie: 'renkei_session=secret; theme=dark',
          'content-type': 'text/plain',
          'accept-encoding': 'gzip, br',
          connection: 'keep-alive',
          host: 'r.example',
          'x-forwarded-proto': 'https',
        },
        body: 'payload',
      }
    );
    const response = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/api/code/projects/p1/chats/c1/previews/web/app/', path: ['page', 'a'] }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://sandbox.internal:8092/v1/previews/proxy/web/page/a?x=1');
    expect(init?.method).toBe('POST');
    expect(init).toEqual(expect.objectContaining({ duplex: 'half', redirect: 'manual' }));
    const sent = new Headers(init?.headers);
    expect(sent.get('authorization')).toBe('Bearer test-key');
    expect(sent.get('x-sandbox-subject')).toBe('code-project:p1');
    expect(sent.get('cookie')).toBe('theme=dark');
    expect(sent.get('accept-encoding')).toBe('identity');
    expect(sent.get('connection')).toBeNull();
    expect(sent.get('x-forwarded-host')).toBe('r.example');
    expect(sent.get('x-forwarded-proto')).toBe('https');
    expect(sent.get('x-forwarded-prefix')).toBe('/api/code/projects/p1/chats/c1/previews/web/app');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('set-cookie')).toBe('app=1; Path=/');
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('<h1>hi</h1>');
  });

  it('neither sends the preview the app’s own cookies nor lets it set them', async () => {
    const upstream = new Headers({ 'content-type': 'text/html' });
    upstream.append('set-cookie', 'renkei_session=forged; Path=/');
    upstream.append('set-cookie', 'oidc_state=forged; Path=/');
    upstream.append('set-cookie', 'connect_state_x=forged; Path=/');
    upstream.append('set-cookie', 'app=1; Path=/');
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200, headers: upstream }));
    const request = new NextRequest(
      'https://r.example/api/code/projects/p1/chats/c1/previews/web/app/',
      {
        headers: {
          cookie: 'renkei_session=secret; oidc_state=s; connect_state_x=c; theme=dark',
        },
      }
    );
    const response = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/api/code/projects/p1/chats/c1/previews/web/app/', path: [] }
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(new Headers(init?.headers).get('cookie')).toBe('theme=dark');
    expect(response.headers.getSetCookie()).toEqual(['app=1; Path=/']);
  });

  it('drops a cookie header that held only the session, and sends no body on a GET', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 304 }));
    const request = new NextRequest('https://r.example/api/code/preview/' + 'a'.repeat(43) + '/', {
      headers: { cookie: 'renkei_session=secret' },
    });
    const response = await previewRelay(
      request,
      { token: 'a'.repeat(43) },
      { prefix: `/api/code/preview/${'a'.repeat(43)}/`, path: undefined }
    );
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`http://sandbox.internal:8092/v1/previews/public/${'a'.repeat(43)}/`);
    expect(new Headers(init?.headers).get('cookie')).toBeNull();
    expect(new Headers(init?.headers).get('x-sandbox-subject')).toBeNull();
    expect(init?.body).toBeUndefined();
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  it('rewrites a path redirect under the preview’s prefix', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: '/login' } }));
    const request = new NextRequest('https://r.example/api/code/projects/p1/previews/web/app/');
    const response = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/api/code/projects/p1/previews/web/app/', path: undefined }
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/api/code/projects/p1/previews/web/app/login');
  });

  it('refuses a dot segment in the path before anything is relayed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const request = new NextRequest('https://r.example/api/code/projects/p1/previews/web/app/x');
    const response = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/api/code/projects/p1/previews/web/app/', path: ['..', 'env', 'list'] }
    );
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 503 when the sandbox is not configured and 502 when it cannot be reached', async () => {
    delete process.env.SANDBOX_WORKER_URL;
    const request = new NextRequest('https://r.example/api/code/projects/p1/previews/web/app/');
    const unconfigured = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/p/', path: undefined }
    );
    expect(unconfigured.status).toBe(503);
    process.env.SANDBOX_WORKER_URL = 'http://sandbox.internal:8092';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const down = await previewRelay(
      request,
      { subject: 'code-project:p1', name: 'web' },
      { prefix: '/p/', path: undefined }
    );
    expect(down.status).toBe(502);
  });
});

describe('the start payload and the addresses', () => {
  it('reads a name, a command, the ports by name, public and the wait', () => {
    expect(
      parsePreviewStartPayload({
        name: 'web',
        command: 'pnpm dev',
        ports: ['web', 'api'],
        public: true,
        waitSeconds: 90,
      })
    ).toEqual({
      name: 'web',
      command: 'pnpm dev',
      ports: ['web', 'api'],
      public: true,
      waitMs: 90_000,
    });
    expect(parsePreviewStartPayload({ name: 'web', command: 'pnpm dev' })).toEqual({
      name: 'web',
      command: 'pnpm dev',
      ports: ['app'],
      public: false,
    });
    expect(parsePreviewStartPayload({ name: 'Web', command: 'x' })).toHaveProperty('error');
    expect(parsePreviewStartPayload({ name: 'web', command: '' })).toHaveProperty('error');
    expect(parsePreviewStartPayload({ name: 'web', command: 'x', ports: [3000] })).toHaveProperty(
      'error'
    );
    expect(parsePreviewStartPayload('nope')).toHaveProperty('error');
  });

  it('mints a token of the published shape and builds every port’s addresses', () => {
    const token = mintPreviewToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintPreviewToken()).not.toBe(token);
    const addresses = previewAddresses('https://r.example/', {
      projectId: 'p1',
      chatId: 'c1',
      name: 'web',
      ports: [
        { name: 'app', token },
        { name: 'api', token: null },
      ],
    });
    expect(addresses).toEqual({
      url: 'https://r.example/api/code/projects/p1/chats/c1/previews/web/app/',
      publicUrl: `https://r.example/api/code/preview/${token}/`,
      ports: [
        {
          name: 'app',
          url: 'https://r.example/api/code/projects/p1/chats/c1/previews/web/app/',
          publicUrl: `https://r.example/api/code/preview/${token}/`,
          token,
        },
        {
          name: 'api',
          url: 'https://r.example/api/code/projects/p1/chats/c1/previews/web/ports/api/',
          publicUrl: null,
          token: null,
        },
      ],
    });
    // What the worker is told: the public address where there is a token, the member's otherwise.
    expect(previewPortRequests(addresses)).toEqual([
      { name: 'app', url: `https://r.example/api/code/preview/${token}/`, token },
      {
        name: 'api',
        url: 'https://r.example/api/code/projects/p1/chats/c1/previews/web/ports/api/',
      },
    ]);
    expect(
      previewAddresses('https://r.example', {
        projectId: 'p1',
        chatId: null,
        name: 'web',
        ports: [{ name: 'app', token: null }],
      }).url
    ).toBe('https://r.example/api/code/projects/p1/previews/web/app/');
  });
});
