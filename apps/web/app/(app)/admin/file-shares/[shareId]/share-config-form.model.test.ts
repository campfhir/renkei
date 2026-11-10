/**
 * One file share's edit page (share-config-form.model.ts), as an operator
 * would describe it. These were file-shares.spec.ts's "key on file" and
 * "back to trust-on-first-use" steps (and the reason it waited for the
 * network to settle: a second load putting the stored value back over an
 * edit); what PATCH stores is app/api/admin/file-shares/[shareId]/route.test.ts.
 */

import {
  draftFromShare,
  hostKeyStatus,
  initialShareForm,
  shareFormReducer,
  type ShareFormAction,
  type ShareFormState,
  type StoredShare,
} from './share-config-form.model';

const FINGERPRINT = 'SHA256:zgO0mL4RkHlb6yVSZS1Bz0Ys7gs0Ia0ZLyTRpFH9bXw';

const stored = (more: Partial<StoredShare> = {}): StoredShare => ({
  id: 's-1',
  name: 'Reports SFTP',
  protocol: 'sftp',
  host: 'files.corp.example',
  port: null,
  shareName: null,
  rootPath: '/srv/reports',
  caseInsensitive: false,
  enabled: true,
  hostKeyFingerprint: FINGERPRINT,
  ...more,
});

const run = (actions: ShareFormAction[], from: ShareFormState = initialShareForm) =>
  actions.reduce(shareFormReducer, from);

describe('loading', () => {
  it('opens with the stored values, the key on file in its field', () => {
    const state = run([{ type: 'loaded', share: stored({ port: 2222 }) }]);
    expect(state.draft).toMatchObject({
      name: 'Reports SFTP',
      port: '2222',
      shareName: '',
      hostKeyFingerprint: FINGERPRINT,
    });
  });

  it('no port and no key open as empty fields', () => {
    const draft = draftFromShare(stored({ hostKeyFingerprint: null }));
    expect(draft.port).toBe('');
    expect(draft.hostKeyFingerprint).toBe('');
  });

  it('a load landing after the person started typing keeps what they typed', () => {
    const state = run([
      { type: 'loaded', share: stored() },
      { type: 'edit', patch: { hostKeyFingerprint: '' } },
      { type: 'loaded', share: stored() },
    ]);
    expect(state.draft?.hostKeyFingerprint).toBe('');
  });

  it('a failed load says why', () => {
    expect(run([{ type: 'load-failed', error: 'Not found' }]).status).toEqual({
      kind: 'error',
      text: 'Not found',
    });
  });
});

describe('the host-key status', () => {
  it('names the key on file', () => {
    expect(hostKeyStatus(run([{ type: 'loaded', share: stored() }]))).toEqual({
      kind: 'on-file',
      fingerprint: FINGERPRINT,
    });
  });

  it('says the first connection records one when none is on file', () => {
    const state = run([{ type: 'loaded', share: stored({ hostKeyFingerprint: null }) }]);
    expect(hostKeyStatus(state)).toEqual({ kind: 'first-use' });
  });

  it('is not shown for an SMB share', () => {
    const state = run([
      { type: 'loaded', share: stored({ protocol: 'smb', hostKeyFingerprint: null }) },
    ]);
    expect(hostKeyStatus(state)).toBeNull();
  });

  it('follows what is stored: clearing the field says nothing until saved and reloaded', () => {
    const cleared = run([
      { type: 'loaded', share: stored() },
      { type: 'edit', patch: { hostKeyFingerprint: '' } },
    ]);
    expect(hostKeyStatus(cleared)?.kind).toBe('on-file');
    const saved = run(
      [
        { type: 'sent' },
        { type: 'saved' },
        { type: 'loaded', share: stored({ hostKeyFingerprint: null }) },
      ],
      cleared
    );
    expect(saved.status).toEqual({ kind: 'ok', text: 'Saved.' });
    expect(hostKeyStatus(saved)).toEqual({ kind: 'first-use' });
    expect(saved.draft?.hostKeyFingerprint).toBe('');
  });
});

describe('saving and deleting', () => {
  it('a refused save keeps the edit and shows why', () => {
    const state = run([
      { type: 'loaded', share: stored() },
      { type: 'edit', patch: { name: 'Taken' } },
      { type: 'sent' },
      { type: 'failed', error: 'A share with that name exists' },
    ]);
    expect(state.draft?.name).toBe('Taken');
    expect(state.status).toEqual({ kind: 'error', text: 'A share with that name exists' });
    expect(state.busy).toBe(false);
  });

  it('anything in flight disables the buttons and clears the last message', () => {
    const state = run([
      { type: 'loaded', share: stored() },
      { type: 'failed', error: 'x' },
      { type: 'sent' },
    ]);
    expect(state.busy).toBe(true);
    expect(state.status).toBeNull();
  });

  it('switching protocol in the edit form sets case matching too', () => {
    const state = run([
      { type: 'loaded', share: stored() },
      { type: 'edit', patch: { protocol: 'smb' } },
    ]);
    expect(state.draft?.caseInsensitive).toBe(true);
  });
});
