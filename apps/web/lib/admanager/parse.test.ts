import { parseConnectPayload, parseExposurePayload, parseInstancePayload } from './parse';

describe('parseInstancePayload', () => {
  it('accepts a minimal valid instance', () => {
    const result = parseInstancePayload({ name: 'Prod', baseUrl: 'https://admp.example:8080' });
    expect('input' in result).toBe(true);
    if ('input' in result) {
      expect(result.input).toEqual({
        name: 'Prod',
        environment: 'prod',
        baseUrl: 'https://admp.example:8080',
        tlsVerify: true,
        caPem: undefined,
        allowInsecureHttp: false,
        resetPasswordTemplateName: null,
        enabled: true,
      });
    }
  });

  it('keeps a reset-password template name verbatim, blank as null, and refuses a multi-line one', () => {
    const named = parseInstancePayload({
      name: 'Prod',
      baseUrl: 'https://admp.example',
      resetPasswordTemplateName: '  Reset Password – must change  ',
    });
    if ('input' in named) {
      expect(named.input.resetPasswordTemplateName).toBe('Reset Password – must change');
    } else throw new Error(named.error);
    for (const blank of [undefined, null, '', '   ']) {
      const result = parseInstancePayload({
        name: 'Prod',
        baseUrl: 'https://admp.example',
        resetPasswordTemplateName: blank,
      });
      if ('input' in result) expect(result.input.resetPasswordTemplateName).toBeNull();
      else throw new Error(result.error);
    }
    expect(
      parseInstancePayload({
        name: 'Prod',
        baseUrl: 'https://admp.example',
        resetPasswordTemplateName: 'two\nlines',
      })
    ).toHaveProperty('error');
    expect(
      parseInstancePayload({
        name: 'Prod',
        baseUrl: 'https://admp.example',
        resetPasswordTemplateName: 'x'.repeat(256),
      })
    ).toHaveProperty('error');
  });

  it('refuses a missing name or an unusable baseUrl', () => {
    expect(parseInstancePayload({ baseUrl: 'https://admp.example' })).toHaveProperty('error');
    expect(parseInstancePayload({ name: 'Prod', baseUrl: 'not a url' })).toHaveProperty('error');
    expect(
      parseInstancePayload({ name: 'Prod', baseUrl: 'http://admp.example' })
    ).toHaveProperty('error');
  });

  it('allows http only with allowInsecureHttp', () => {
    const result = parseInstancePayload({
      name: 'Lab',
      baseUrl: 'http://admp.example',
      allowInsecureHttp: true,
    });
    expect('input' in result).toBe(true);
  });

  it('requires PEM-shaped text for caPem, and treats an empty string as clearing it', () => {
    expect(
      parseInstancePayload({ name: 'Prod', baseUrl: 'https://admp.example', caPem: 'not pem' })
    ).toHaveProperty('error');
    const cleared = parseInstancePayload({
      name: 'Prod',
      baseUrl: 'https://admp.example',
      caPem: '',
    });
    if ('input' in cleared) expect(cleared.input.caPem).toBeNull();
  });
});

describe('parseExposurePayload', () => {
  it('refuses an unknown permission id', () => {
    expect(parseExposurePayload({ permissions: ['accounts.read', 'bogus'] })).toHaveProperty(
      'error'
    );
  });

  it('normalizes known permissions and defaults to reads when asked', () => {
    expect(parseExposurePayload({ permissions: ['groups.modify', 'accounts.read'] })).toEqual({
      permissions: ['accounts.read', 'groups.modify'],
    });
    expect(parseExposurePayload({}, { defaultToReads: true })).toEqual({
      permissions: ['accounts.read'],
    });
    expect(parseExposurePayload({})).toHaveProperty('error');
  });
});

describe('parseConnectPayload', () => {
  it('requires both an authtoken and a technician name', () => {
    expect(parseConnectPayload({ authToken: 'tok' })).toHaveProperty('error');
    expect(parseConnectPayload({ technicianName: 'Alice' })).toHaveProperty('error');
  });

  it('builds credentials and defaults to read-only exposure', () => {
    const result = parseConnectPayload({ authToken: ' tok123 ', technicianName: 'Alice' });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.credentials).toEqual({ authToken: 'tok123' });
      expect(result.technicianName).toBe('Alice');
      expect(result.permissions).toEqual(['accounts.read']);
    }
  });
});
