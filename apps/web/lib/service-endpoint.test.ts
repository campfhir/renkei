import { checkServiceEndpoint } from './service-endpoint';

const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

describe('checkServiceEndpoint', () => {
  it('accepts https for any host, public or private', async () => {
    expect(await checkServiceEndpoint('https://api.openai.com/v1', resolveTo('8.8.8.8'))).toEqual({
      ok: true,
    });
    expect(await checkServiceEndpoint('https://gateway.corp.example/v1')).toEqual({ ok: true });
  });

  it('accepts plain http only to a host on a private network', async () => {
    expect(await checkServiceEndpoint('http://127.0.0.1:9000/v1')).toEqual({ ok: true });
    expect(await checkServiceEndpoint('http://llm.internal/v1', resolveTo('10.1.2.3'))).toEqual({
      ok: true,
    });
    const publicHttp = await checkServiceEndpoint(
      'http://llm.example.com/v1',
      resolveTo('8.8.8.8')
    );
    expect(publicHttp).toMatchObject({ ok: false });
    const unresolved = await checkServiceEndpoint('http://nowhere.example/v1', resolveTo());
    expect(unresolved).toMatchObject({ ok: false });
  });

  it.each([
    'https://169.254.169.254/latest',
    'http://169.254.169.254/latest',
    'https://[::ffff:a9fe:a9fe]/',
    'https://[fe80::1]/',
    'https://metadata.google.internal/computeMetadata/v1',
  ])('refuses link-local and metadata address %s whatever the scheme', async (url) => {
    expect(await checkServiceEndpoint(url, resolveTo('10.0.0.1'))).toMatchObject({ ok: false });
  });

  it('refuses things that are not http(s) URLs', async () => {
    expect(await checkServiceEndpoint('ftp://example.com')).toMatchObject({ ok: false });
    expect(await checkServiceEndpoint('not a url')).toMatchObject({ ok: false });
  });
});
