import { configuredDirectory } from './configured-path';

const NAME = 'SANDBOX_TEST_DIRECTORY';

afterEach(() => {
  delete process.env[NAME];
});

describe('a directory named by the environment', () => {
  it('falls back when unset or blank', () => {
    expect(configuredDirectory(NAME, '/fallback')).toBe('/fallback');
    process.env[NAME] = '   ';
    expect(configuredDirectory(NAME, '/fallback')).toBe('/fallback');
  });

  it('accepts a plain absolute path, trimmed', () => {
    process.env[NAME] = ' /srv/renkei-data/v1.2+dev ';
    expect(configuredDirectory(NAME, '/fallback')).toBe('/srv/renkei-data/v1.2+dev');
    process.env[NAME] = '/';
    expect(configuredDirectory(NAME, '/fallback')).toBe('/');
  });

  it('refuses a relative path, a parent segment, or shell punctuation', () => {
    for (const odd of ['data', '/data/../etc', '/da ta', '/data;id', '$HOME/data']) {
      process.env[NAME] = odd;
      expect(() => configuredDirectory(NAME, '/fallback')).toThrow(/must be an absolute path/);
    }
  });
});
