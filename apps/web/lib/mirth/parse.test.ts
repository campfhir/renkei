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
  it('normalizes destructive away without write', () => {
    expect(parseExposurePayload({ toolAccess: 'read', allowDestructive: true })).toEqual({
      toolAccess: 'read',
      allowDestructive: false,
    });
    expect(parseExposurePayload({ toolAccess: 'read_write', allowDestructive: true })).toEqual({
      toolAccess: 'read_write',
      allowDestructive: true,
    });
    expect('error' in parseExposurePayload({ toolAccess: 'admin' })).toBe(true);
  });

  it('requires a username and password', () => {
    expect('error' in parseConnectPayload({ toolAccess: 'read', username: 'a' })).toBe(true);
    expect('error' in parseConnectPayload({ toolAccess: 'read', password: 'p' })).toBe(true);
    expect(parseConnectPayload({ toolAccess: 'read', username: ' a ', password: 'p' })).toEqual({
      toolAccess: 'read',
      allowDestructive: false,
      credentials: { username: 'a', password: 'p' },
    });
  });
});
