/**
 * The configuration caches keep their own default unless
 * RENKEI_CONFIG_CACHE_TTL_MS names a usable lifetime.
 */

import { configCacheTtlMs } from './config-cache';

describe('configCacheTtlMs', () => {
  it('keeps the default when the variable is unset or unusable', () => {
    expect(configCacheTtlMs(60_000, {})).toBe(60_000);
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: '' })).toBe(60_000);
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: '  ' })).toBe(60_000);
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: 'soon' })).toBe(60_000);
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: '-1' })).toBe(60_000);
  });

  it('takes a number of milliseconds, zero included', () => {
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: '0' })).toBe(0);
    expect(configCacheTtlMs(60_000, { RENKEI_CONFIG_CACHE_TTL_MS: '2500' })).toBe(2_500);
  });
});
