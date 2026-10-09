import {
  checkInsecureTransport,
  insecureTransportModes,
  isProductionLabel,
} from './insecure-transport';

const DNS: Record<string, string[]> = {
  'lab.corp.internal': ['10.20.30.40'],
  'dual.corp.internal': ['10.20.30.40', '203.0.113.9'],
  'mirth.example.com': ['203.0.113.9'],
  'ula.corp.internal': ['fd12:3456::1'],
};

const resolve = async (hostname: string): Promise<string[]> => {
  const answer = DNS[hostname];
  if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return answer;
};

describe('insecureTransportModes', () => {
  it('names each switched-off protection, and nothing for a secure configuration', () => {
    expect(insecureTransportModes({ tlsVerify: true, allowInsecureHttp: false })).toEqual([]);
    expect(insecureTransportModes({})).toEqual([]);
    expect(insecureTransportModes({ tlsVerify: false })).toEqual(['tls_verify_off']);
    expect(insecureTransportModes({ allowInsecureHttp: true })).toEqual(['plaintext_http']);
    expect(insecureTransportModes({ tlsVerify: false, allowInsecureHttp: true })).toEqual([
      'tls_verify_off',
      'plaintext_http',
    ]);
  });
});

describe('isProductionLabel', () => {
  it('matches the production spellings as whole words', () => {
    for (const label of [
      'prod',
      'PROD',
      'production',
      'prd',
      'us-prod',
      'prod 2',
      'live',
      ' Prod ',
    ]) {
      expect(isProductionLabel(label)).toBe(true);
    }
  });

  it('leaves other environments alone', () => {
    for (const label of [
      'dev',
      'test',
      'staging',
      'preprod',
      'product-test',
      'site-a',
      'lab',
      '',
    ]) {
      expect(isProductionLabel(label)).toBe(false);
    }
  });
});

describe('checkInsecureTransport', () => {
  it('allows a secure configuration anywhere, production included, without resolving', async () => {
    const lookup = jest.fn(resolve);
    expect(
      await checkInsecureTransport(
        { modes: [], production: true, urls: ['https://mirth.example.com:8443'] },
        lookup
      )
    ).toEqual({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses every insecure mode on a production instance', async () => {
    const verdict = await checkInsecureTransport(
      { modes: ['tls_verify_off'], production: true, urls: ['https://lab.corp.internal:8443'] },
      resolve
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/production instance must use https/);
    const plaintext = await checkInsecureTransport(
      { modes: ['plaintext_http'], production: true, urls: ['http://10.0.0.5:8080'] },
      resolve
    );
    expect(plaintext.ok).toBe(false);
  });

  it('allows an insecure mode for a host that resolves only to private addresses', async () => {
    for (const url of [
      'http://lab.corp.internal:8080',
      'https://ula.corp.internal',
      'http://10.0.0.5:8080',
      'http://127.0.0.1:8443',
      'http://[::1]:8080',
      'http://192.168.1.20',
    ]) {
      expect(
        await checkInsecureTransport(
          { modes: ['tls_verify_off', 'plaintext_http'], production: false, urls: [url] },
          resolve
        )
      ).toEqual({ ok: true });
    }
  });

  it('refuses a host that resolves to any public address, naming it', async () => {
    for (const url of [
      'http://mirth.example.com:8443',
      'http://dual.corp.internal',
      'http://203.0.113.9',
    ]) {
      const verdict = await checkInsecureTransport(
        { modes: ['plaintext_http'], production: false, urls: [url] },
        resolve
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error).toMatch(/public address 203\.0\.113\.9/);
    }
  });

  it('refuses a host that does not resolve rather than guessing', async () => {
    const verdict = await checkInsecureTransport(
      { modes: ['tls_verify_off'], production: false, urls: ['https://nowhere.corp.internal'] },
      resolve
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/could not be resolved/);
  });

  it('checks every URL an instance is dialled at', async () => {
    const verdict = await checkInsecureTransport(
      {
        modes: ['plaintext_http'],
        production: false,
        urls: ['http://lab.corp.internal/api', 'http://mirth.example.com/idp'],
      },
      resolve
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('mirth.example.com');
  });
});
