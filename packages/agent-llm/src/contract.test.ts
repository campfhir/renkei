/**
 * The shared bits every adapter leans on: the Azure hostname sniff, and
 * the WireRequestCause narrowing a logging call site uses to pull the raw
 * request back out of an Err.cause without knowing which adapter built it.
 */

import { isAzureHost, wireRequestCauseOf } from './contract';

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
  it('narrows a well-formed cause', () => {
    const cause = { summary: 'POST https://x/y\n{}', request: { model: 'gpt-5', messages: [] } };
    expect(wireRequestCauseOf(cause)).toEqual(cause);
  });

  it('rejects anything that is not the expected shape', () => {
    expect(wireRequestCauseOf(undefined)).toBeNull();
    expect(wireRequestCauseOf(null)).toBeNull();
    expect(wireRequestCauseOf('a string cause')).toBeNull();
    expect(wireRequestCauseOf({ summary: 'ok' })).toBeNull();
    expect(wireRequestCauseOf({ request: {} })).toBeNull();
    expect(wireRequestCauseOf({ summary: 'ok', request: null })).toBeNull();
    expect(wireRequestCauseOf({ summary: 'ok', request: 'not an object' })).toBeNull();
  });
});
