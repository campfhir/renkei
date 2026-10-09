import { loggableQuery, REDACTED_VALUE } from './request-log-redaction';

describe('loggableQuery', () => {
  it('logs nothing for a request with no query', () => {
    expect(loggableQuery('/api/health', '')).toBeUndefined();
    expect(loggableQuery('/api/health', '?')).toBeUndefined();
  });

  it('drops the whole query string for webhook deliveries', () => {
    expect(
      loggableQuery(
        '/api/webhooks/bitbucket/00000000-0000-4000-8000-000000000001',
        '?secret=s3cret'
      )
    ).toBeUndefined();
    expect(
      loggableQuery('/api/webhooks/microsoft/t/a', '?validationToken=abc&harmless=1')
    ).toBeUndefined();
  });

  it('redacts credential-shaped parameters elsewhere and keeps the rest', () => {
    const logged = loggableQuery(
      '/api/oauth/callback',
      '?code=4/0AX4XfWh&state=f6a1c4b2&scope=read'
    );
    expect(logged).toBeDefined();
    const params = new URLSearchParams(logged);
    expect(params.get('code')).toBe(REDACTED_VALUE);
    expect(params.get('state')).toBe(REDACTED_VALUE);
    expect(params.get('scope')).toBe('read');
  });

  it('redacts regardless of parameter-name case', () => {
    const params = new URLSearchParams(loggableQuery('/api/x', '?Token=abc&SECRET=def'));
    expect(params.get('Token')).toBe(REDACTED_VALUE);
    expect(params.get('SECRET')).toBe(REDACTED_VALUE);
  });

  it('returns an untouched query when nothing in it is sensitive', () => {
    expect(loggableQuery('/acme/usage', '?user=alice&range=30d')).toBe('?user=alice&range=30d');
  });
});
