/**
 * The option parsers every start path shares, and the consent gate that
 * keeps a batch from doing to a share what its owner never allowed the
 * tools to do there.
 */

import type { ConnectedShare } from '@renkei/connector-fileshares';
import {
  afterProcessingRefusal,
  normalizeFolderPath,
  parseAfterProcessing,
  parseSkipProcessed,
} from './pipeline-options';

function share(
  id: string,
  toolAccess: 'read' | 'read_write',
  allowDelete: boolean
): ConnectedShare {
  return {
    share: {
      id,
      name: `Share ${id}`,
      protocol: 'smb',
      host: 'nas',
      port: null,
      shareName: 'docs',
      rootPath: '/',
      caseInsensitive: true,
      enabled: true,
    },
    connection: { username: 'alice', toolAccess, allowDelete },
  };
}

describe('parseSkipProcessed', () => {
  it('defaults to on, honours a boolean, refuses anything else', () => {
    expect(parseSkipProcessed(undefined)).toBe(true);
    expect(parseSkipProcessed(false)).toBe(false);
    expect(parseSkipProcessed('no')).toBeNull();
  });
});

describe('normalizeFolderPath', () => {
  it('canonicalises to a rooted Unix path', () => {
    expect(normalizeFolderPath('done')).toBe('/done');
    expect(normalizeFolderPath('\\done\\2026\\')).toBe('/done/2026');
    expect(normalizeFolderPath('')).toBe('/');
  });

  it('rejects traversal rather than resolving it', () => {
    expect(normalizeFolderPath('/done/../secret')).toBeNull();
    expect(normalizeFolderPath('./done')).toBeNull();
  });
});

describe('parseAfterProcessing', () => {
  it('defaults to keep', () => {
    expect(parseAfterProcessing(undefined)).toEqual({ action: 'keep' });
    expect(parseAfterProcessing({ action: 'keep' })).toEqual({ action: 'keep' });
  });

  it('accepts delete and a normalised move', () => {
    expect(parseAfterProcessing({ action: 'delete' })).toEqual({ action: 'delete' });
    expect(parseAfterProcessing({ action: 'move', shareId: 's2', path: 'done/' })).toEqual({
      action: 'move',
      shareId: 's2',
      path: '/done',
    });
  });

  it('refuses a move without a share, a traversal path, or an unknown action', () => {
    expect(parseAfterProcessing({ action: 'move', path: '/done' })).toBeNull();
    expect(parseAfterProcessing({ action: 'move', shareId: 's2', path: '/../x' })).toBeNull();
    expect(parseAfterProcessing({ action: 'archive' })).toBeNull();
    expect(parseAfterProcessing('delete')).toBeNull();
  });
});

describe('afterProcessingRefusal', () => {
  const rw = share('s1', 'read_write', true);
  const ro = share('s2', 'read', false);
  const writeOnly = share('s3', 'read_write', false);

  it('requires the source share to be connected, whatever the action', () => {
    expect(afterProcessingRefusal([rw], 'nope', { action: 'keep' })).toMatch(/not connected/);
  });

  it('lets keep through on any connection', () => {
    expect(afterProcessingRefusal([ro], 's2', { action: 'keep' })).toBeNull();
  });

  it('needs write and delete tools on the source to delete or move', () => {
    expect(afterProcessingRefusal([ro], 's2', { action: 'delete' })).toMatch(/write tools/);
    expect(afterProcessingRefusal([writeOnly], 's3', { action: 'delete' })).toMatch(/delete tools/);
    expect(
      afterProcessingRefusal([writeOnly], 's3', { action: 'move', shareId: 's3', path: '/done' })
    ).toMatch(/delete tools/);
    expect(afterProcessingRefusal([rw], 's1', { action: 'delete' })).toBeNull();
    expect(
      afterProcessingRefusal([rw], 's1', { action: 'move', shareId: 's1', path: '/done' })
    ).toBeNull();
  });

  it('needs the destination share connected with write tools for a cross-share move', () => {
    expect(
      afterProcessingRefusal([rw], 's1', { action: 'move', shareId: 's9', path: '/' })
    ).toMatch(/destination/);
    expect(
      afterProcessingRefusal([rw, ro], 's1', { action: 'move', shareId: 's2', path: '/' })
    ).toMatch(/write tools/);
    expect(
      afterProcessingRefusal([rw, writeOnly], 's1', { action: 'move', shareId: 's3', path: '/' })
    ).toBeNull();
  });
});
