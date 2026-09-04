import { describeRefusal } from './azure-errors';

const headersOf = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

describe('describeRefusal', () => {
  it('quotes the signing detail Storage returns on a MAC mismatch', () => {
    const body = `<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.
RequestId:abc
Time:2026-09-04T05:00:00Z</Message><AuthenticationErrorDetail>The MAC signature found in the HTTP request 'xyz' is not the same as any computed signature. Server used following string to sign: 'GET


x-ms-date:Thu, 04 Sep 2026 05:00:00 GMT
x-ms-version:2023-11-03
/renkeichat/renkei-chat/probe/t/1'.</AuthenticationErrorDetail></Error>`;
    const refusal = describeRefusal(
      403,
      headersOf({ 'x-ms-error-code': 'AuthenticationFailed', 'x-ms-request-id': 'abc' }),
      body
    );
    expect(refusal.kind).toBe('AUTH');
    expect(refusal.message).toMatch(
      /^Azure Blob 403 AuthenticationFailed: Server failed to authenticate/
    );
    expect(refusal.message).toMatch(/string to sign: 'GET x-ms-date:/);
    expect(refusal.message).toMatch(/request abc$/);
  });

  it('reads the code from the body when the header is missing', () => {
    const refusal = describeRefusal(
      404,
      headersOf({}),
      '<Error><Code>BlobNotFound</Code><Message>The specified blob does not exist.</Message></Error>'
    );
    expect(refusal.kind).toBe('NOT_FOUND');
    expect(refusal.message).toBe('Azure Blob 404 BlobNotFound: The specified blob does not exist.');
  });

  it('names the edge when a WAF block answers instead of Storage', () => {
    const refusal = describeRefusal(
      403,
      headersOf({ 'x-azure-ref': '20260904T050000Z-abc123', 'content-type': 'text/html' }),
      '<html><body><h1>The request is blocked.</h1><p>Reference: 20260904T050000Z-abc123</p></body></html>'
    );
    expect(refusal.kind).toBe('AUTH');
    expect(refusal.message).toMatch(
      /^Blocked before reaching Azure Blob \(403 from the edge; x-azure-ref 20260904T050000Z-abc123\)/
    );
    expect(refusal.message).toMatch(/WAF rule or route refused/);
    expect(refusal.message).toMatch(/The edge said: The request is blocked\. Reference:/);
  });

  it('frames other statuses from the edge as the route’s problem, and clips the body', () => {
    const refusal = describeRefusal(502, headersOf({}), 'x'.repeat(5_000));
    expect(refusal.kind).toBe('PROVIDER_ERROR');
    expect(refusal.message).toMatch(
      /^Blocked before reaching Azure Blob \(502 from the edge; no x-ms-error-code/
    );
    expect(refusal.message).toMatch(/check the route’s origin/);
    expect(refusal.message.length).toBeLessThan(800);
  });
});
