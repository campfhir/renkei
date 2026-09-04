/**
 * The signer's promise: the string-to-sign is assembled exactly as the
 * Shared Key rules say — standard headers in order, empty Content-Length
 * for a bodiless request, x-ms-* headers lowercased and sorted, the
 * resource prefixed with the account and query parameters appended — and
 * the signature is the HMAC of that string under the base64-decoded key.
 */

import { createHmac } from 'node:crypto';
import { authorizationHeader, sharedKeySignature, stringToSign } from './azure-sign';

// Azurite's published development key — a public constant, not a secret.
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

describe('stringToSign', () => {
  it('builds the canonical form for a Put Blob', () => {
    const value = stringToSign({
      verb: 'put',
      headers: {
        'x-ms-version': '2023-11-03',
        'X-MS-Date': 'Thu, 04 Sep 2026 10:00:00 GMT',
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'text/plain',
      },
      contentLength: 5,
      account: 'devstoreaccount1',
      resourcePath: '/renkei-chat/chat/t/a',
      query: {},
    });
    expect(value).toBe(
      [
        'PUT',
        '', // Content-Encoding
        '', // Content-Language
        '5', // Content-Length
        '', // Content-MD5
        'text/plain', // Content-Type
        '', // Date
        '', // If-Modified-Since
        '', // If-Match
        '', // If-None-Match
        '', // If-Unmodified-Since
        '', // Range
        'x-ms-blob-type:BlockBlob',
        'x-ms-date:Thu, 04 Sep 2026 10:00:00 GMT',
        'x-ms-version:2023-11-03',
        '/devstoreaccount1/renkei-chat/chat/t/a',
      ].join('\n')
    );
  });

  it('leaves Content-Length empty for a bodiless request and appends query parameters', () => {
    const value = stringToSign({
      verb: 'PUT',
      headers: { 'x-ms-date': 'd', 'x-ms-version': 'v' },
      contentLength: 0,
      account: 'acct',
      resourcePath: '/renkei-chat',
      query: { restype: 'container' },
    });
    expect(value.split('\n')[3]).toBe('');
    expect(value.endsWith('/acct/renkei-chat\nrestype:container')).toBe(true);
  });
});

describe('sharedKeySignature', () => {
  it('is the base64 HMAC-SHA256 of the string-to-sign under the decoded key', () => {
    const input = {
      verb: 'GET',
      headers: { 'x-ms-date': 'Thu, 04 Sep 2026 10:00:00 GMT', 'x-ms-version': '2023-11-03' },
      contentLength: 0,
      account: 'devstoreaccount1',
      resourcePath: '/renkei-chat/chat/t/a',
      query: {},
    };
    const expected = createHmac('sha256', Buffer.from(AZURITE_KEY, 'base64'))
      .update(stringToSign(input), 'utf8')
      .digest('base64');
    expect(sharedKeySignature(input, AZURITE_KEY)).toBe(expected);
    expect(authorizationHeader(input, AZURITE_KEY)).toBe(`SharedKey devstoreaccount1:${expected}`);
  });
});
