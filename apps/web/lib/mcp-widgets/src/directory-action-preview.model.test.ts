/**
 * The directory action card's rules (directory-action-preview.model.ts):
 * what an ADManager preview shows, what Confirm sends, and what confirming
 * or cancelling leaves. The confirm call, its receipt and its note to the
 * model used to be checked through the card's iframe in a browser
 * (directory-action-preview.spec.ts); the spec now keeps the long group
 * list's bounded pane, the phone width and the one press end to end.
 */

import {
  cancelOutcome,
  confirmCall,
  confirmOutcome,
  copyLabel,
  copyReducer,
  openingReceipt,
  readPreview,
  type CopyAction,
  type CopyState,
  type DirectoryPreview,
} from './directory-action-preview.model';

const MANY_GROUPS = Array.from({ length: 120 }, (_, i) => `Dept-${String(i + 1).padStart(3, '0')}`);

const COPY_GROUPS = {
  kind: 'directory_action',
  previewId: 'prev-1',
  action: 'Copy group membership',
  tone: 'neutral',
  title: 'Copy groups from Sam Source to Jane Doe',
  subtitle: 'ADManager Plus prod · corp.example.com',
  person: { name: 'Jane Doe', detail: 'jdoe · corp.example.com' },
  secondaryPerson: { label: 'Copying groups from', name: 'Sam Source', detail: 'ssource' },
  groupLists: [{ label: 'Groups to add', groups: MANY_GROUPS, tone: 'add' }],
  confirmTool: 'admanager_add_user_to_groups_confirm',
  confirmLabel: 'Copy groups',
  confirmArgs: {
    instanceId: 'i1',
    domainName: 'corp.example.com',
    samAccountName: 'jdoe',
    groupNames: MANY_GROUPS,
  },
};

function ready(content: unknown): DirectoryPreview {
  const preview = readPreview(content, false, '');
  if (!preview.ok) throw new Error(`expected a reviewable preview, got: ${preview.error}`);
  return preview;
}

describe('what the card shows', () => {
  it('shows whose account it is, and whose groups are copied, not a generic field list', () => {
    const preview = ready(COPY_GROUPS);
    expect(preview.title).toBe('Copy groups from Sam Source to Jane Doe');
    expect(preview.person).toEqual({ name: 'Jane Doe', detail: 'jdoe · corp.example.com' });
    expect(preview.secondaryPerson).toEqual({
      name: 'Sam Source',
      detail: 'ssource',
      label: 'Copying groups from',
    });
    expect(preview.fields).toEqual([]);
    expect(preview.confirmLabel).toBe('Copy groups');
  });

  it('keeps every group of a long list, with its count beside the label', () => {
    const [list] = ready(COPY_GROUPS).groupLists;
    expect(list?.groups).toHaveLength(120);
    expect(list?.groups[0]).toBe('Dept-001');
    expect(list?.groups[119]).toBe('Dept-120');
    expect(list?.count.trim()).toBe('(120)');
    expect(list?.chipClass).toBe('done');
  });

  it('colours groups being removed as urgent, and an unnamed tone as muted', () => {
    const preview = ready({
      ...COPY_GROUPS,
      groupLists: [
        { label: 'Groups to remove', groups: ['VPN'], tone: 'remove' },
        { label: 'Stays', groups: ['All staff'], tone: 'sparkly' },
      ],
    });
    expect(preview.groupLists.map((list) => [list.tone, list.chipClass])).toEqual([
      ['remove', 'urgent'],
      ['muted', 'neutral'],
    ]);
  });

  it('leaves out a group list with no groups in it', () => {
    const preview = ready({
      ...COPY_GROUPS,
      groupLists: [{ label: 'Groups to remove', groups: [], tone: 'remove' }],
    });
    expect(preview.groupLists).toEqual([]);
  });

  it('colours the action chip by its tone, and shows none without an action', () => {
    expect(ready({ ...COPY_GROUPS, tone: 'positive' }).action).toEqual({
      label: 'Copy group membership',
      chipClass: 'done',
    });
    expect(ready({ ...COPY_GROUPS, tone: 'caution' }).action?.chipClass).toBe('warn');
    expect(ready({ ...COPY_GROUPS, tone: 'odd' }).action?.chipClass).toBe('neutral');
    expect(ready({ ...COPY_GROUPS, action: '' }).action).toBeNull();
  });

  it('shows a changed attribute with what it was', () => {
    const preview = ready({
      ...COPY_GROUPS,
      fields: [
        { label: 'Title', value: 'Manager', oldValue: 'Analyst' },
        { label: 'Department', value: 'Finance' },
      ],
    });
    expect(preview.fields).toEqual([
      { label: 'Title', value: 'Manager', oldValue: 'Analyst' },
      { label: 'Department', value: 'Finance' },
    ]);
  });

  it('shows a reset password plainly, labelled Password unless the tool names it', () => {
    expect(ready({ ...COPY_GROUPS, secret: { value: 'Tr0ub4dor&3' } }).secret).toEqual({
      label: 'Password',
      value: 'Tr0ub4dor&3',
      note: '',
    });
    expect(
      ready({
        ...COPY_GROUPS,
        secret: { label: 'Temporary password', value: 'x', note: 'Must change at sign-in.' },
      }).secret
    ).toEqual({ label: 'Temporary password', value: 'x', note: 'Must change at sign-in.' });
    expect(ready({ ...COPY_GROUPS, secret: { label: 'Password', value: '' } }).secret).toBeNull();
  });

  it('labels a second person with no role "Also involved", and shows nobody unnamed', () => {
    const preview = ready({ ...COPY_GROUPS, secondaryPerson: { name: 'Sam Source' } });
    expect(preview.secondaryPerson?.label).toBe('Also involved');
    expect(ready({ ...COPY_GROUPS, person: {}, secondaryPerson: {} })).toMatchObject({
      person: null,
      secondaryPerson: null,
    });
  });

  it('reads Confirm when the tool names no button', () => {
    expect(ready({ ...COPY_GROUPS, confirmLabel: '' }).confirmLabel).toBe('Confirm');
  });

  it('shows only the error when the preview failed or names nothing to confirm', () => {
    expect(readPreview(COPY_GROUPS, true, 'ADManager is unreachable.')).toEqual({
      ok: false,
      title: 'Copy groups from Sam Source to Jane Doe',
      error: 'ADManager is unreachable.',
    });
    expect(readPreview({ title: '' }, false, '')).toEqual({
      ok: false,
      title: 'Directory action',
      error: 'The preview could not be prepared.',
    });
    expect(readPreview(null, false, '')).toMatchObject({ ok: false });
  });
});

describe('which receipt a card opens on', () => {
  const remembered = { icon: 'cancelled' as const, headline: 'Cancelled' };

  it('keeps each preview’s decision under its own id, so a second preview is not decided', () => {
    expect(ready(COPY_GROUPS).stateKey).toBe('renkei-preview:prev-1');
    expect(ready({ ...COPY_GROUPS, previewId: 'prev-2' }).stateKey).toBe('renkei-preview:prev-2');
    expect(ready({ ...COPY_GROUPS, previewId: '' }).stateKey).toBe('');
  });

  it('opens on a decision made on another device over this browser’s own', () => {
    const resolved = { icon: 'sent', headline: 'Added Jane Doe to 120 groups.' };
    expect(openingReceipt({ ...COPY_GROUPS, resolved }, remembered)).toEqual(resolved);
  });

  it('falls back to this browser’s receipt, and opens undecided with neither', () => {
    expect(openingReceipt(COPY_GROUPS, remembered)).toEqual(remembered);
    expect(openingReceipt({ ...COPY_GROUPS, resolved: { icon: 'nope' } }, null)).toBeNull();
  });
});

describe('confirming', () => {
  it('sends the preview’s own tool and arguments, every group included', () => {
    expect(confirmCall(ready(COPY_GROUPS))).toEqual({
      name: 'admanager_add_user_to_groups_confirm',
      args: COPY_GROUPS.confirmArgs,
    });
  });

  it('ends on the first line of the answer, and tells the model what happened', () => {
    const outcome = confirmOutcome(ready(COPY_GROUPS), {
      isError: false,
      text: 'Added Jane Doe to 120 groups.\nSkipped none.',
    });
    expect(outcome).toEqual({
      ok: true,
      done: {
        icon: 'sent',
        headline: 'Added Jane Doe to 120 groups.',
        detail: 'ADManager Plus prod · corp.example.com',
      },
      context:
        'The user confirmed "Copy groups from Sam Source to Jane Doe" on the preview card. ' +
        'Result: Added Jane Doe to 120 groups.\nSkipped none.',
    });
  });

  it('says Done for a silent answer, and names the title when there is no subtitle', () => {
    const outcome = confirmOutcome(
      { title: 'Unlock jdoe', subtitle: '' },
      {
        isError: false,
        text: '',
      }
    );
    expect(outcome).toMatchObject({ ok: true, done: { headline: 'Done', detail: 'Unlock jdoe' } });
  });

  it('carries a link from the answer onto the receipt', () => {
    const outcome = confirmOutcome(ready(COPY_GROUPS), {
      isError: false,
      text: 'Created jdoe. [Open in ADManager](https://adm.example.com/u/jdoe)',
    });
    expect(outcome.ok && outcome.done.links).toEqual([
      { label: 'Open in ADManager', href: 'https://adm.example.com/u/jdoe' },
    ]);
  });

  it('a refused action shows why and leaves the card to try again', () => {
    expect(confirmOutcome(ready(COPY_GROUPS), { isError: true, text: 'Access denied.' })).toEqual({
      ok: false,
      error: 'Access denied.',
    });
    expect(confirmOutcome(ready(COPY_GROUPS), { isError: true, text: '' })).toEqual({
      ok: false,
      error: 'The action failed',
    });
  });
});

describe('cancelling', () => {
  it('changes nothing and says so, on the card and to the model', () => {
    expect(cancelOutcome(ready(COPY_GROUPS))).toEqual({
      done: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing changed.' },
      context:
        'The user cancelled "Copy groups from Sam Source to Jane Doe" from the preview card. ' +
        'Nothing changed.',
    });
  });
});

describe('the password’s copy button', () => {
  const press = (...actions: CopyAction[]) =>
    copyLabel(actions.reduce<CopyState>(copyReducer, 'idle'));

  it('reads Copy, then Copied once the clipboard takes it, then Copy again', () => {
    expect(press()).toBe('Copy');
    expect(press({ type: 'copied' })).toBe('Copied');
    expect(press({ type: 'copied' }, { type: 'reset' })).toBe('Copy');
  });

  it('asks the person to select it when the frame has no clipboard or it refuses', () => {
    expect(press({ type: 'refused' })).toBe('Select to copy');
    expect(press({ type: 'refused' }, { type: 'reset' })).toBe('Copy');
  });
});
