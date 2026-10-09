import { Readable } from 'node:stream';
import { BlockedUrlError as SandboxBlockedUrlError } from '@renkei/connector-sandbox';
import { assertSafeHttpsUrl, isBlockedIP, safeFetch, BlockedUrlError } from './safe-fetch';

describe('isBlockedIP', () => {
  it('blocks loopback, private, link-local, CGNAT, and reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isBlockedIP(ip)).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.0.1']) {
      expect(isBlockedIP(ip)).toBe(false);
    }
  });

  it('blocks IPv6 loopback, link-local, unique-local, and mapped-private', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:169.254.169.254',
    ]) {
      expect(isBlockedIP(ip)).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedIP('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertSafeHttpsUrl', () => {
  it('accepts a normal https issuer URL', () => {
    expect(assertSafeHttpsUrl('https://login.microsoftonline.com/tenant/v2.0').hostname).toBe(
      'login.microsoftonline.com'
    );
  });

  it('rejects non-https schemes', () => {
    expect(() => assertSafeHttpsUrl('http://example.com')).toThrow(BlockedUrlError);
    expect(() => assertSafeHttpsUrl('file:///etc/passwd')).toThrow(BlockedUrlError);
    expect(() => assertSafeHttpsUrl('gopher://example.com')).toThrow(BlockedUrlError);
  });

  it('rejects the localhost family', () => {
    expect(() => assertSafeHttpsUrl('https://localhost/x')).toThrow(/not allowed/);
    expect(() => assertSafeHttpsUrl('https://foo.localhost/x')).toThrow(/not allowed/);
  });

  it('rejects private and metadata IP literals', () => {
    expect(() => assertSafeHttpsUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      /private or reserved/
    );
    expect(() => assertSafeHttpsUrl('https://127.0.0.1:8080/')).toThrow(/private or reserved/);
    expect(() => assertSafeHttpsUrl('https://[::1]/')).toThrow(/private or reserved/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertSafeHttpsUrl('not a url')).toThrow(BlockedUrlError);
  });
});

describe('safeFetch', () => {
  const resolve = async (hostname: string): Promise<string> => {
    if (hostname === 'login.example') return '93.184.216.34';
    if (hostname === 'internal.example') {
      throw new SandboxBlockedUrlError('host resolves to a private or reserved address');
    }
    throw new SandboxBlockedUrlError(`could not resolve ${hostname}`);
  };
  type Transport = NonNullable<Parameters<typeof safeFetch>[2]>['transport'];
  const dialled: Array<{ href: string; address: string; host: string }> = [];
  const transport: Transport = async (request) => {
    dialled.push({
      href: request.url.href,
      address: request.address,
      host: request.headers.host,
    });
    if (request.url.pathname === '/to-metadata') {
      return {
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
        body: null,
      };
    }
    if (request.url.pathname === '/to-http') {
      return {
        status: 302,
        statusText: 'Found',
        headers: { location: 'http://login.example/plain' },
        body: null,
      };
    }
    if (request.url.pathname === '/to-internal') {
      return {
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://internal.example/' },
        body: null,
      };
    }
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: Readable.from([Buffer.from('{"issuer":"https://login.example"}')]),
    };
  };

  beforeEach(() => {
    dialled.length = 0;
  });

  it('dials the verified address and keeps the hostname for the Host header', async () => {
    const response = await safeFetch(
      'https://login.example/.well-known/openid-configuration',
      undefined,
      { resolve, transport }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: 'https://login.example' });
    expect(dialled).toEqual([
      {
        href: 'https://login.example/.well-known/openid-configuration',
        address: '93.184.216.34',
        host: 'login.example',
      },
    ]);
  });

  it('refuses a redirect to the metadata address, to http://, and to a private name', async () => {
    for (const path of ['/to-metadata', '/to-http', '/to-internal']) {
      await expect(
        safeFetch(`https://login.example${path}`, undefined, { resolve, transport })
      ).rejects.toThrow(BlockedUrlError);
    }
    // Only the first hop of each was ever dialled.
    expect(dialled.map((entry) => entry.href)).toEqual([
      'https://login.example/to-metadata',
      'https://login.example/to-http',
      'https://login.example/to-internal',
    ]);
  });

  it('refuses a name that does not resolve as this file’s BlockedUrlError', async () => {
    await expect(
      safeFetch('https://nowhere.example/', undefined, { resolve, transport })
    ).rejects.toThrow(BlockedUrlError);
    expect(dialled).toHaveLength(0);
  });
});
