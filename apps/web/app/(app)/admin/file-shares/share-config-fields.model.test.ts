/**
 * The file-share draft (share-config-fields.model.ts), as an operator
 * would describe it. These were file-shares.spec.ts's form steps (the
 * fingerprint field for SFTP only, its live verdict); what the share
 * routes store is app/api/admin/file-shares/[shareId]/route.test.ts.
 */

import {
  canCreate,
  draftPayload,
  editDraft,
  emptyDraft,
  hostKeyPreview,
  pathPreview,
  portPlaceholder,
  visibleFields,
} from './share-config-fields.model';

/** A well-formed SHA256 host-key fingerprint, as `ssh-keygen -lf` prints one. */
const FINGERPRINT = 'SHA256:zgO0mL4RkHlb6yVSZS1Bz0Ys7gs0Ia0ZLyTRpFH9bXw';

describe('a new share', () => {
  it('starts as SMB at the root, matching case-insensitively, enabled', () => {
    expect(emptyDraft()).toMatchObject({
      protocol: 'smb',
      rootPath: '/',
      caseInsensitive: true,
      enabled: true,
    });
  });

  it('SMB asks for a share name and has no host key; SFTP the other way round', () => {
    expect(visibleFields('smb')).toEqual({ shareName: true, hostKey: false });
    expect(visibleFields('sftp')).toEqual({ shareName: false, hostKey: true });
  });

  it('the port placeholder names each protocol’s default', () => {
    expect(portPlaceholder('smb')).toBe('445 (default)');
    expect(portPlaceholder('sftp')).toBe('22 (default)');
  });

  it('switching to SFTP matches case exactly, and back to SMB folds it again', () => {
    const sftp = editDraft(emptyDraft(), { protocol: 'sftp' });
    expect(sftp.caseInsensitive).toBe(false);
    expect(editDraft(sftp, { protocol: 'smb' }).caseInsensitive).toBe(true);
  });

  it('case matching can still be changed after choosing the protocol', () => {
    const sftp = editDraft(emptyDraft(), { protocol: 'sftp' });
    expect(editDraft(sftp, { caseInsensitive: true }).caseInsensitive).toBe(true);
  });

  it('Create needs a name and a host, and nothing in flight', () => {
    expect(canCreate(emptyDraft(), false)).toBe(false);
    const ready = editDraft(emptyDraft(), { name: 'Reports', host: 'files.corp.example' });
    expect(canCreate(ready, false)).toBe(true);
    expect(canCreate(ready, true)).toBe(false);
    expect(canCreate(editDraft(ready, { host: '  ' }), false)).toBe(false);
  });
});

describe('what Create or Save sends', () => {
  it('an SFTP share sends its pinned fingerprint, an empty port as null', () => {
    const draft = editDraft(emptyDraft(), {
      protocol: 'sftp',
      name: 'Reports SFTP',
      host: 'files.corp.example',
      rootPath: '/srv/reports',
      hostKeyFingerprint: FINGERPRINT,
    });
    expect(draftPayload(draft)).toEqual({
      name: 'Reports SFTP',
      protocol: 'sftp',
      host: 'files.corp.example',
      port: null,
      shareName: undefined,
      rootPath: '/srv/reports',
      caseInsensitive: false,
      enabled: true,
      hostKeyFingerprint: FINGERPRINT,
    });
  });

  it('a cleared fingerprint is sent empty, which returns the share to trust-on-first-use', () => {
    const draft = editDraft(emptyDraft(), { protocol: 'sftp', hostKeyFingerprint: '' });
    expect(draftPayload(draft).hostKeyFingerprint).toBe('');
  });

  it('an SMB share never sends a host key, even one typed before switching', () => {
    const draft = editDraft(
      editDraft(emptyDraft(), { protocol: 'sftp', hostKeyFingerprint: FINGERPRINT }),
      {
        protocol: 'smb',
        shareName: 'accounting',
        port: '1445',
      }
    );
    const body = draftPayload(draft);
    expect(body.hostKeyFingerprint).toBeNull();
    expect(body.shareName).toBe('accounting');
    expect(body.port).toBe(1445);
  });
});

describe('the host-key verdict', () => {
  it('empty: the first connection records the key for the admin to confirm', () => {
    const preview = hostKeyPreview('');
    expect(preview.error).toBe(false);
    expect(preview.text).toContain('recorded here for you to confirm');
  });

  it('something else than a SHA256 fingerprint is flagged', () => {
    expect(hostKeyPreview('MD5:aa:bb:cc')).toEqual({
      text: 'Not a SHA256 fingerprint — paste what `ssh-keygen -lf` prints.',
      error: true,
    });
  });

  it('a bare or padded fingerprint is normalized and shown as pinned', () => {
    const bare = `${FINGERPRINT.slice('SHA256:'.length)}=`;
    expect(hostKeyPreview(bare)).toEqual({
      text: `Pinned as ${FINGERPRINT}; a server presenting any other key is refused.`,
      error: false,
    });
  });
});

describe('the root path preview', () => {
  it('shows a Windows path the way it will be stored', () => {
    expect(pathPreview('\\finance\\2024')).toEqual({
      text: 'Stored as /finance/2024',
      error: false,
    });
  });

  it('an empty path is the root', () => {
    expect(pathPreview('').text).toBe('Stored as /');
  });

  it('a path that climbs upward is flagged', () => {
    expect(pathPreview('/srv/../etc').error).toBe(true);
  });
});
