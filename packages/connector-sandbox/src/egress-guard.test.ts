import { assertSafeHttpsUrl, isBlockedIP, BlockedUrlError } from './egress-guard';

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
  it('accepts a normal https URL', () => {
    expect(assertSafeHttpsUrl('https://example.com/reports/q4.pdf').hostname).toBe('example.com');
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

describe('assertPublicHttpsUrl / resolvePublicAddress', () => {
  const lookup = jest.fn<Promise<Array<{ address: string; family: number }>>, [string, unknown]>();

  beforeEach(() => {
    lookup.mockReset();
    jest.resetModules();
    jest.doMock('node:dns/promises', () => ({ lookup }));
  });

  afterEach(() => {
    jest.dontMock('node:dns/promises');
  });

  async function guard() {
    return import('./egress-guard');
  }

  it('accepts a name whose every answer is public and returns the first', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const { assertPublicHttpsUrl, resolvePublicAddress } = await guard();
    expect((await assertPublicHttpsUrl('https://example.com/x')).hostname).toBe('example.com');
    expect(await resolvePublicAddress('example.com')).toBe('93.184.216.34');
  });

  it('refuses a name with any private answer', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const { assertPublicHttpsUrl } = await guard();
    await expect(assertPublicHttpsUrl('https://rebind.example/')).rejects.toThrow(
      /private or reserved/
    );
  });

  it('refuses a name that does not resolve instead of passing it through', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const { assertPublicHttpsUrl, BlockedUrlError: Blocked } = await guard();
    await expect(assertPublicHttpsUrl('https://nowhere.example/')).rejects.toThrow(Blocked);
    await expect(assertPublicHttpsUrl('https://nowhere.example/')).rejects.toThrow(
      /could not resolve/
    );
  });

  it('refuses a name with no answers at all', async () => {
    lookup.mockResolvedValue([]);
    const { resolvePublicAddress } = await guard();
    await expect(resolvePublicAddress('empty.example')).rejects.toThrow(/could not resolve/);
  });

  it('settles an IP literal without a lookup', async () => {
    const { resolvePublicAddress } = await guard();
    expect(await resolvePublicAddress('93.184.216.34')).toBe('93.184.216.34');
    expect(await resolvePublicAddress('[2606:4700:4700::1111]')).toBe('2606:4700:4700::1111');
    expect(lookup).not.toHaveBeenCalled();
  });
});
