/**
 * The shared bits every adapter leans on: the Azure hostname sniff, the
 * WireRequestCause narrowing a logging call site uses to pull the raw
 * request back out of an Err.cause without knowing which adapter built it,
 * and maskCredentialHeaders' masking of the one thing in it worth hiding.
 */

import { isAzureHost, maskCredentialHeaders, wireRequestCauseOf } from './contract';

describe('isAzureHost', () => {
  it('is true for an Azure host, false for anything else, and false for a bad URL', () => {
    expect(isAzureHost('https://myresource.openai.azure.com/openai/v1')).toBe(true);
    expect(isAzureHost('https://myresource.services.ai.azure.com/anthropic')).toBe(true);
    expect(isAzureHost('https://api.openai.com/v1')).toBe(false);
    expect(isAzureHost('not a url')).toBe(false);
    expect(isAzureHost('')).toBe(false);
  });
});

describe('wireRequestCauseOf', () => {
  const wellFormed = {
    summary: 'POST https://x/y\n{}',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { authorization: 'Bearer sk-real-key', 'content-type': 'application/json' },
    request: { model: 'gpt-5', messages: [] },
  };

  it('narrows a well-formed cause', () => {
    expect(wireRequestCauseOf(wellFormed)).toEqual(wellFormed);
  });

  it('rejects anything missing url, headers, or request', () => {
    expect(wireRequestCauseOf(undefined)).toBeNull();
    expect(wireRequestCauseOf(null)).toBeNull();
    expect(wireRequestCauseOf('a string cause')).toBeNull();
    expect(wireRequestCauseOf({ summary: 'ok' })).toBeNull();
    expect(wireRequestCauseOf({ ...wellFormed, url: undefined })).toBeNull();
    expect(wireRequestCauseOf({ ...wellFormed, headers: null })).toBeNull();
    expect(wireRequestCauseOf({ ...wellFormed, request: null })).toBeNull();
    expect(wireRequestCauseOf({ ...wellFormed, request: 'not an object' })).toBeNull();
  });

  it('drops a non-string header value rather than failing the whole cause', () => {
    const withJunk = { ...wellFormed, headers: { ...wellFormed.headers, weird: 42 } };
    const result = wireRequestCauseOf(withJunk);
    expect(result?.headers).toEqual(wellFormed.headers);
  });
});

describe('maskCredentialHeaders', () => {
  it('masks authorization and api-key (case-insensitively), leaves everything else plain', () => {
    const masked = maskCredentialHeaders(
      {
        Authorization: 'Bearer sk-real-key',
        'api-key': 'azure-real-key',
        'X-Api-Key': 'anthropic-style-key',
        'content-type': 'application/json',
      },
      (value) => `<masked:${value.length}>`
    );
    expect(masked.Authorization).toBe('<masked:18>');
    expect(masked['api-key']).toBe('<masked:14>');
    expect(masked['X-Api-Key']).toBe('<masked:19>');
    expect(masked['content-type']).toBe('application/json');
  });
});
