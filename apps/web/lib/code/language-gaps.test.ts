/**
 * The pure half of the language-gap record: what a file is grouped by,
 * and why it has no server.
 */

import { extensionOf, gapReason } from './language-gaps';

describe('extensionOf', () => {
  test('is the extension, lower-cased', () => {
    expect(extensionOf('src/App.TSX')).toBe('tsx');
    expect(extensionOf('a/b/c.tar.gz')).toBe('gz');
  });

  test('is the whole name when there is no extension or it is all extension', () => {
    expect(extensionOf('Makefile')).toBe('makefile');
    expect(extensionOf('docker/Dockerfile')).toBe('dockerfile');
    expect(extensionOf('.bashrc')).toBe('.bashrc');
    expect(extensionOf('.env.local')).toBe('local');
  });
});

describe('gapReason', () => {
  test('names a language the registry has no server for', () => {
    expect(gapReason('yaml', ['typescript'])).toBe('no_server');
    expect(gapReason('plaintext', [])).toBe('no_server');
  });

  test('names a server the worker lacks, and nothing when it has it', () => {
    expect(gapReason('typescript', [])).toBe('not_installed');
    expect(gapReason('python', ['typescript'])).toBe('not_installed');
    expect(gapReason('typescript', ['typescript'])).toBeNull();
    expect(gapReason('shell', ['bash'])).toBeNull();
  });
});
