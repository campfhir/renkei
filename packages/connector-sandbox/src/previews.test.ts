/**
 * The preview helpers: what a name and a port may be, what the process is
 * told, and the header shaping both proxy hops rely on — the session
 * cookie never crossing into the project's server, hop-by-hop headers
 * never crossing at all, and a server's own redirect landing back inside
 * the preview.
 */
import {
  PREVIEW_START_WAIT_DEFAULT_MS,
  PREVIEW_START_WAIT_MAX_MS,
  isPreviewToken,
  previewEnvironment,
  previewNeighbourEnvironment,
  previewProxyPath,
  previewWaitMs,
  proxyResponseHeaders,
  publicPreviewPath,
  stripCookies,
  stripHopByHop,
  validatePreviewName,
  validatePreviewPort,
} from './previews';

describe('names and ports', () => {
  it('takes a short lower-case name and nothing else', () => {
    expect(validatePreviewName('web')).toEqual({ ok: true, name: 'web' });
    expect(validatePreviewName(' api-2 ')).toEqual({ ok: true, name: 'api-2' });
    expect(validatePreviewName('Web').ok).toBe(false);
    expect(validatePreviewName('2web').ok).toBe(false);
    expect(validatePreviewName('').ok).toBe(false);
  });

  it('lets a preview insist on an unprivileged port, or leave it to the worker', () => {
    expect(validatePreviewPort(undefined)).toEqual({ ok: true, port: null });
    expect(validatePreviewPort(3000)).toEqual({ ok: true, port: 3000 });
    expect(validatePreviewPort(80).ok).toBe(false);
    expect(validatePreviewPort(70_000).ok).toBe(false);
    expect(validatePreviewPort('3000').ok).toBe(false);
  });

  it('bounds the wait for the server to listen', () => {
    expect(previewWaitMs(undefined)).toBe(PREVIEW_START_WAIT_DEFAULT_MS);
    expect(previewWaitMs(10)).toBe(1_000);
    expect(previewWaitMs(10 ** 9)).toBe(PREVIEW_START_WAIT_MAX_MS);
  });

  it('knows a share token by its shape', () => {
    expect(isPreviewToken('a'.repeat(43))).toBe(true);
    expect(isPreviewToken('a'.repeat(42))).toBe(false);
    expect(isPreviewToken('a'.repeat(42) + '/')).toBe(false);
  });
});

describe('what the process is told', () => {
  it('names the port, an interface the proxy reaches, and the public address', () => {
    expect(previewEnvironment(20_123, 'https://app.example/api/code/preview/t/')).toEqual({
      PORT: '20123',
      HOST: '0.0.0.0',
      HOSTNAME: '0.0.0.0',
      RENKEI_PREVIEW_PORT: '20123',
      RENKEI_PREVIEW_URL: 'https://app.example/api/code/preview/t/',
    });
  });

  it('tells a preview and a command about the other previews that are up, by name', () => {
    expect(
      previewNeighbourEnvironment([
        { name: 'web-ui', port: 20_200, url: 'https://app.example/p/web-ui/app/' },
        { name: 'api', port: 20_100, url: 'https://app.example/api/code/preview/t/' },
      ])
    ).toEqual({
      PREVIEW_API_PORT: '20100',
      PREVIEW_API_URL: 'https://app.example/api/code/preview/t/',
      PREVIEW_WEB_UI_PORT: '20200',
      PREVIEW_WEB_UI_URL: 'https://app.example/p/web-ui/app/',
    });
    expect(previewNeighbourEnvironment([])).toEqual({});
  });

  it('addresses a preview through the project, the chat, or a token', () => {
    expect(previewProxyPath({ projectId: 'p1', name: 'web' })).toBe(
      '/api/code/projects/p1/previews/web/app/'
    );
    expect(previewProxyPath({ projectId: 'p1', chatId: 'c1', name: 'web' })).toBe(
      '/api/code/projects/p1/chats/c1/previews/web/app/'
    );
    expect(publicPreviewPath('tok')).toBe('/api/code/preview/tok/');
  });
});

describe('proxy headers', () => {
  it('drops hop-by-hop headers and the host, keeps the rest lower-cased', () => {
    expect(
      stripHopByHop({
        Host: 'app.example',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket',
        Accept: 'text/html',
        'X-Custom': ['a', 'b'],
        Missing: undefined,
      })
    ).toEqual({ accept: 'text/html', 'x-custom': ['a', 'b'] });
  });

  it('takes the session cookie out of the cookie header and leaves the server its own', () => {
    expect(stripCookies('renkei_session=abc; theme=dark; sid=1', ['renkei_session'])).toBe(
      'theme=dark; sid=1'
    );
    expect(stripCookies('renkei_session=abc', ['renkei_session'])).toBe('');
    expect(stripCookies('  a=1 ;; b=2', [])).toBe('a=1; b=2');
  });

  it('rewrites a path redirect under the proxy prefix and leaves absolute ones alone', () => {
    expect(
      proxyResponseHeaders(
        { Location: '/login?next=%2F', 'Content-Type': 'text/html', Connection: 'close' },
        '/api/code/projects/p1/previews/web/app/'
      )
    ).toEqual({
      location: '/api/code/projects/p1/previews/web/app/login?next=%2F',
      'content-type': 'text/html',
    });
    expect(proxyResponseHeaders({ location: 'https://elsewhere.example/x' }, '/p/')).toEqual({
      location: 'https://elsewhere.example/x',
    });
    expect(proxyResponseHeaders({ location: '//evil.example/x' }, '/p/')).toEqual({
      location: '//evil.example/x',
    });
  });
});
