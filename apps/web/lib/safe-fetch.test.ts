import { assertSafeHttpsUrl, isBlockedIP, BlockedUrlError } from './safe-fetch';

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
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:169.254.169.254']) {
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
