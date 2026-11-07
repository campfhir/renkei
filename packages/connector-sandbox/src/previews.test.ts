/**
 * The preview helpers: what a name and a list of port names may be, the
 * system's port pool and its override, what the process is told for each
 * port, what the neighbours are told, and the header shaping both proxy
 * hops rely on — the session cookie never crossing into the project's
 * server, hop-by-hop headers never crossing at all, and a server's own
 * redirect landing back inside the preview.
 */
import {
  DEFAULT_PREVIEW_PORT_RANGE,
  PREVIEW_START_WAIT_DEFAULT_MS,
  PREVIEW_START_WAIT_MAX_MS,
  isPreviewToken,
  parsePreviewPortRange,
  previewEnvironment,
  previewNeighbourEnvironment,
  previewPortPool,
  previewProxyPath,
  previewWaitMs,
  proxyResponseHeaders,
  publicPreviewPath,
  stripCookies,
  stripHopByHop,
  validatePreviewName,
  validatePreviewPorts,
} from './previews';

describe('names and ports', () => {
  it('takes a short lower-case name and nothing else', () => {
    expect(validatePreviewName('web')).toEqual({ ok: true, name: 'web' });
    expect(validatePreviewName(' api-2 ')).toEqual({ ok: true, name: 'api-2' });
    expect(validatePreviewName('Web').ok).toBe(false);
    expect(validatePreviewName('2web').ok).toBe(false);
    expect(validatePreviewName('').ok).toBe(false);
  });

  it('declares ports by name: one called app by default, several unique ones at most eight', () => {
    expect(validatePreviewPorts(undefined)).toEqual({ ok: true, ports: ['app'] });
    expect(validatePreviewPorts(['web', 'api'])).toEqual({ ok: true, ports: ['web', 'api'] });
    expect(validatePreviewPorts([]).ok).toBe(false);
    expect(validatePreviewPorts(['web', 'web']).ok).toBe(false);
    expect(validatePreviewPorts(['Web']).ok).toBe(false);
    expect(validatePreviewPorts([3000]).ok).toBe(false);
    expect(validatePreviewPorts(Array.from({ length: 9 }, (_, i) => `p${i}`)).ok).toBe(false);
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

describe('the port pool', () => {
  it('is 10000-10050 unless the environment says otherwise', () => {
    expect(DEFAULT_PREVIEW_PORT_RANGE).toEqual({ min: 10_000, max: 10_050 });
    const pool = previewPortPool();
    expect(pool).toHaveLength(51);
    expect(pool[0]).toBe(10_000);
    expect(pool[50]).toBe(10_050);
    expect(parsePreviewPortRange(undefined)).toEqual({
      ok: true,
      range: DEFAULT_PREVIEW_PORT_RANGE,
    });
    expect(parsePreviewPortRange(' 20000-20010 ')).toEqual({
      ok: true,
      range: { min: 20_000, max: 20_010 },
    });
    expect(previewPortPool({ min: 20_000, max: 20_002 })).toEqual([20_000, 20_001, 20_002]);
  });

  it('refuses a malformed, privileged, backwards or too-wide range, saying why', () => {
    for (const bad of ['abc', '80-90', '10050-10000', '10000-70000', '10000-12000', '10000']) {
      const parsed = parsePreviewPortRange(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain('SANDBOX_PREVIEW_PORTS');
    }
  });
});

describe('what the process is told', () => {
  it('names PORT for the first port and PORT_<NAME> for each, with where each is served', () => {
    expect(
      previewEnvironment([
        { name: 'web', port: 10_000, url: 'https://app.example/p/web/app/' },
        { name: 'api', port: 10_001, url: 'https://app.example/api/code/preview/t/' },
      ])
    ).toEqual({
      PORT: '10000',
      HOST: '0.0.0.0',
      HOSTNAME: '0.0.0.0',
      RENKEI_PREVIEW_PORT: '10000',
      RENKEI_PREVIEW_URL: 'https://app.example/p/web/app/',
      PORT_WEB: '10000',
      RENKEI_PREVIEW_URL_WEB: 'https://app.example/p/web/app/',
      PORT_API: '10001',
      RENKEI_PREVIEW_URL_API: 'https://app.example/api/code/preview/t/',
    });
    expect(previewEnvironment([])).toEqual({});
  });

  it('tells a preview and a command about the other previews that are up, by name and by port', () => {
    expect(
      previewNeighbourEnvironment([
        {
          name: 'web-ui',
          ports: [{ name: 'app', port: 10_002, url: 'https://app.example/p/web-ui/app/' }],
        },
        {
          name: 'api',
          ports: [
            { name: 'http', port: 10_000, url: 'https://app.example/api/code/preview/t/' },
            { name: 'ws', port: 10_001, url: 'https://app.example/p/api/ports/ws/' },
          ],
        },
      ])
    ).toEqual({
      PREVIEW_API_PORT: '10000',
      PREVIEW_API_URL: 'https://app.example/api/code/preview/t/',
      PREVIEW_API_HTTP_PORT: '10000',
      PREVIEW_API_HTTP_URL: 'https://app.example/api/code/preview/t/',
      PREVIEW_API_WS_PORT: '10001',
      PREVIEW_API_WS_URL: 'https://app.example/p/api/ports/ws/',
      PREVIEW_WEB_UI_PORT: '10002',
      PREVIEW_WEB_UI_URL: 'https://app.example/p/web-ui/app/',
      PREVIEW_WEB_UI_APP_PORT: '10002',
      PREVIEW_WEB_UI_APP_URL: 'https://app.example/p/web-ui/app/',
    });
    expect(previewNeighbourEnvironment([])).toEqual({});
  });

  it('addresses a preview through the project, the chat, a named port, or a token', () => {
    expect(previewProxyPath({ projectId: 'p1', name: 'web' })).toBe(
      '/api/code/projects/p1/previews/web/app/'
    );
    expect(previewProxyPath({ projectId: 'p1', chatId: 'c1', name: 'web' })).toBe(
      '/api/code/projects/p1/chats/c1/previews/web/app/'
    );
    expect(previewProxyPath({ projectId: 'p1', chatId: 'c1', name: 'web', port: 'api' })).toBe(
      '/api/code/projects/p1/chats/c1/previews/web/ports/api/'
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
