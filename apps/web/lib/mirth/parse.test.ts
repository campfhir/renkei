import { parseConnectPayload, parseExposurePayload, parseInstancePayload } from './parse';

describe('parseInstancePayload', () => {
  it('normalizes a full instance', () => {
    const parsed = parseInstancePayload({
      name: ' Prod ',
      environment: 'prod',
      baseUrl: 'https://mirth.example:8443/api/',
      tlsVerify: false,
      caPem: '',
      enabled: true,
    });
    expect(parsed).toEqual({
      input: {
        name: 'Prod',
        environment: 'prod',
        baseUrl: 'https://mirth.example:8443',
        tlsVerify: false,
        caPem: null,
        allowInsecureHttp: false,
        enabled: true,
      },
    });
  });

  it('defaults the environment, keeps an absent CA, and verifies TLS unless told otherwise', () => {
    const parsed = parseInstancePayload({ name: 'Dev', baseUrl: 'https://dev.example' });
    expect('input' in parsed && parsed.input.environment).toBe('prod');
    expect('input' in parsed && parsed.input.caPem).toBeUndefined();
    expect('input' in parsed && parsed.input.tlsVerify).toBe(true);
  });

  it('refuses plaintext without the explicit flag, and accepts it with', () => {
    expect('error' in parseInstancePayload({ name: 'Lab', baseUrl: 'http://lab:8080' })).toBe(true);
    const allowed = parseInstancePayload({
      name: 'Lab',
      baseUrl: 'http://lab:8080',
      allowInsecureHttp: true,
    });
    expect('input' in allowed && allowed.input.baseUrl).toBe('http://lab:8080');
  });

  it('refuses a non-PEM CA and a bad environment label', () => {
    expect(
      'error' in parseInstancePayload({ name: 'X', baseUrl: 'https://x', caPem: 'nope' })
    ).toBe(true);
    expect(
      'error' in parseInstancePayload({ name: 'X', baseUrl: 'https://x', environment: 'a/b' })
    ).toBe(true);
    const pem = parseInstancePayload({
      name: 'X',
      baseUrl: 'https://x',
      caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });
    expect('input' in pem && pem.input.caPem).toContain('BEGIN CERTIFICATE');
  });
});

describe('exposure and connect payloads', () => {
  it('validates permission ids, refusing unknown ones and folding order', () => {
    expect(parseExposurePayload({ permissions: ['messages.send', 'channels.read'] })).toEqual({
      permissions: ['channels.read', 'messages.send'],
    });
    expect('error' in parseExposurePayload({ permissions: ['channels.nuke'] })).toBe(true);
    expect('error' in parseExposurePayload({ permissions: 'channels.read' })).toBe(true);
    expect('error' in parseExposurePayload({})).toBe(true);
    expect(parseExposurePayload({}, { defaultToReads: true })).toEqual({
      permissions: [
        'channels.read',
        'messages.read',
        'alerts.read',
        'code_templates.read',
        'users.read',
        'events.read',
        'server.read',
      ],
    });
  });

  it('requires a username and password, defaulting permissions to the reads', () => {
    expect('error' in parseConnectPayload({ username: 'a' })).toBe(true);
    expect('error' in parseConnectPayload({ password: 'p' })).toBe(true);
    const parsed = parseConnectPayload({ username: ' a ', password: 'p', permissions: [] });
    expect(parsed).toEqual({ permissions: [], credentials: { username: 'a', password: 'p' } });
    const defaulted = parseConnectPayload({ username: 'a', password: 'p' });
    expect('permissions' in defaulted && defaulted.permissions).toContain('channels.read');
  });
});
