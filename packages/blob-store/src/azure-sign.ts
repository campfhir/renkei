/**
 * Azure Storage Shared Key authorization — the string-to-sign, built by
 * hand per the published rules for x-ms-version ≥ 2015-02-21:
 *
 *   VERB \n Content-Encoding \n Content-Language \n Content-Length \n
 *   Content-MD5 \n Content-Type \n Date \n If-Modified-Since \n If-Match \n
 *   If-None-Match \n If-Unmodified-Since \n Range \n
 *   CanonicalizedHeaders CanonicalizedResource
 *
 * where Content-Length is the empty string when zero, CanonicalizedHeaders
 * is every `x-ms-*` header lowercased, sorted, as `name:value\n`, and
 * CanonicalizedResource is `/{account}/{container}/{blob}` followed by
 * each query parameter (lowercased, sorted) as `\n{name}:{value}`. The
 * signature is HMAC-SHA256 over that string with the base64-decoded key.
 *
 * Pure — no clock, no network — so it can be checked against fixed inputs.
 */

import { createHmac } from 'node:crypto';

export interface SharedKeyInput {
  verb: string;
  /** Request headers, any casing; only the ones the spec names are read. */
  headers: Record<string, string>;
  /** Raw byte length of the body, 0 for none. */
  contentLength: number;
  account: string;
  /** `/container/blob` — the path below the account. */
  resourcePath: string;
  /** Query parameters, decoded. */
  query: Record<string, string>;
}

function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return '';
}

export function stringToSign(input: SharedKeyInput): string {
  const standard = [
    header(input.headers, 'content-encoding'),
    header(input.headers, 'content-language'),
    input.contentLength > 0 ? String(input.contentLength) : '',
    header(input.headers, 'content-md5'),
    header(input.headers, 'content-type'),
    header(input.headers, 'date'),
    header(input.headers, 'if-modified-since'),
    header(input.headers, 'if-match'),
    header(input.headers, 'if-none-match'),
    header(input.headers, 'if-unmodified-since'),
    header(input.headers, 'range'),
  ];
  const canonicalHeaders = Object.entries(input.headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .filter(([key]) => key.startsWith('x-ms-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
  const canonicalQuery = Object.entries(input.query)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `\n${key}:${value}`)
    .join('');
  const path = input.resourcePath.startsWith('/') ? input.resourcePath : `/${input.resourcePath}`;
  const canonicalResource = `/${input.account}${path}${canonicalQuery}`;
  return `${input.verb.toUpperCase()}\n${standard.join('\n')}\n${canonicalHeaders}${canonicalResource}`;
}

export function sharedKeySignature(input: SharedKeyInput, keyBase64: string): string {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64'))
    .update(stringToSign(input), 'utf8')
    .digest('base64');
}

export function authorizationHeader(input: SharedKeyInput, keyBase64: string): string {
  return `SharedKey ${input.account}:${sharedKeySignature(input, keyBase64)}`;
}
