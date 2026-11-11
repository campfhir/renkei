import {
  hostMemberPath,
  hostTokenPath,
  mintPreviewSession,
  mintPreviewTicket,
  openPreviewSession,
  openPreviewTicket,
  parsePreviewHost,
  parsePreviewHostPath,
  previewSigningKey,
  PREVIEW_SESSION_TTL_MS,
  PREVIEW_TICKET_TTL_MS,
  requestHost,
  safePreviewHostPath,
} from './preview-host';

const key = previewSigningKey(Buffer.alloc(32, 7));
const NOW = 1_800_000_000_000;

describe('the preview host setting', () => {
  it('takes a host name, lower-cased, with an optional port; empty turns it off', () => {
    expect(parsePreviewHost(' Preview.Example.com ', 'https://app.example.com')).toEqual({
      ok: true,
      host: 'preview.example.com',
    });
    expect(parsePreviewHost('preview.example.com:8443', null)).toMatchObject({ ok: true });
    expect(parsePreviewHost('', 'https://app.example.com')).toEqual({ ok: true, host: '' });
  });

  it.each([
    'https://preview.example.com',
    'preview.example.com/x',
    'localhost',
    'a b.com',
    '*.x.com',
  ])('refuses %s', (input) => {
    expect(parsePreviewHost(input, null).ok).toBe(false);
  });

  it('refuses the app’s own host: that separates nothing', () => {
    expect(parsePreviewHost('app.example.com', 'https://app.example.com').ok).toBe(false);
  });
});

describe('which host a request arrived for', () => {
  it('is what the proxy forwarded, else the request’s own', () => {
    expect(
      requestHost(new Headers({ 'x-forwarded-host': 'Preview.Example.com', host: 'app:3000' }))
    ).toBe('preview.example.com');
    expect(requestHost(new Headers({ host: 'app.example.com' }))).toBe('app.example.com');
  });
});

describe('paths on the preview host', () => {
  it('round-trip through the parser', () => {
    const member = hostMemberPath({ projectId: 'p1', name: 'web' });
    expect(member).toBe('/p/p1/web/app/');
    expect(parsePreviewHostPath(['p', 'p1', 'web', 'app', 'a', 'b'])).toEqual({
      kind: 'member',
      projectId: 'p1',
      chatId: null,
      name: 'web',
      port: null,
      prefix: '/p/p1/web/app/',
      rest: ['a', 'b'],
    });
    expect(parsePreviewHostPath(['p', 'p1', 'c', 'c1', 'web', 'ports', 'api'])).toMatchObject({
      chatId: 'c1',
      port: 'api',
      prefix: hostMemberPath({ projectId: 'p1', chatId: 'c1', name: 'web', port: 'api' }),
      rest: [],
    });
    expect(parsePreviewHostPath(['t', 'tok', 'x'])).toEqual({
      kind: 'token',
      token: 'tok',
      prefix: hostTokenPath('tok'),
      rest: ['x'],
    });
    expect(parsePreviewHostPath(['enter'])).toEqual({ kind: 'enter' });
  });

  it.each([
    [[]],
    [['api', 'agents']],
    [['p']],
    [['p', 'p1']],
    [['p', 'p1', 'web', 'other']],
    [['t']],
  ])('names nothing for %j', (segments) => {
    expect(parsePreviewHostPath(segments)).toBeNull();
  });

  it('lets /enter send a browser only on to a preview on this host', () => {
    expect(safePreviewHostPath('/p/p1/web/app/page?x=1')).toBe('/p/p1/web/app/page?x=1');
    expect(safePreviewHostPath('/t/tok/')).toBe('/t/tok/');
    for (const bad of [
      'https://evil.example/p/p1/web/app/',
      '//evil.example/p/p1/web/app/',
      '/\\evil.example',
      '/%09/evil.example',
      '/enter?ticket=x',
      '/api/agents',
      '',
      null,
    ]) {
      expect(safePreviewHostPath(bad)).toBeNull();
    }
  });
});

describe('the signed handoff', () => {
  it('a ticket names its subject for a minute and no longer', () => {
    const ticket = mintPreviewTicket(key, 'auth0|ann', NOW);
    expect(openPreviewTicket(key, ticket, NOW + 1_000)).toBe('auth0|ann');
    expect(openPreviewTicket(key, ticket, NOW + PREVIEW_TICKET_TTL_MS)).toBeNull();
  });

  it('a session lasts its lifetime, and a ticket is not a session', () => {
    const session = mintPreviewSession(key, 'auth0|ann', NOW);
    expect(openPreviewSession(key, session, NOW + PREVIEW_SESSION_TTL_MS - 1)).toBe('auth0|ann');
    expect(openPreviewSession(key, session, NOW + PREVIEW_SESSION_TTL_MS)).toBeNull();
    expect(openPreviewSession(key, mintPreviewTicket(key, 'auth0|ann', NOW), NOW)).toBeNull();
    expect(openPreviewTicket(key, session, NOW)).toBeNull();
  });

  it('refuses a changed subject, a changed expiry, another key and junk', () => {
    const session = mintPreviewSession(key, 'auth0|ann', NOW);
    const [subject, expiry, signature] = session.split('.');
    const bob = Buffer.from('auth0|bob').toString('base64url');
    expect(openPreviewSession(key, `${bob}.${expiry}.${signature}`, NOW)).toBeNull();
    expect(
      openPreviewSession(key, `${subject}.${Number(expiry) + 1}.${signature}`, NOW)
    ).toBeNull();
    expect(openPreviewSession(previewSigningKey(Buffer.alloc(32, 8)), session, NOW)).toBeNull();
    expect(openPreviewSession(key, 'junk', NOW)).toBeNull();
    expect(openPreviewSession(key, '', NOW)).toBeNull();
  });
});
