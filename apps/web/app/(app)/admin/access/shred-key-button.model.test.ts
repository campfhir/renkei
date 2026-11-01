/**
 * The Access page's "Remove key" (shred-key-button.model.ts). keys.spec.ts
 * walked a wrong typed name through the browser's prompt; it keeps the
 * one removal that goes through. What the server refuses is
 * app/api/admin/access/[subject]/keys/route.test.ts's.
 */

import {
  buttonLabel,
  confirmText,
  initialShred,
  nameConfirmed,
  promptText,
  removalOutcome,
  removeKeyOffered,
  removeKeyPath,
  shredReducer,
  type ShredAction,
} from './shred-key-button.model';

const fold = (actions: ShredAction[]) => actions.reduce(shredReducer, initialShred);

describe('who is offered "Remove key"', () => {
  it('anyone holding a key, never the operator looking', () => {
    expect(removeKeyOffered('bob@example.com', 'op@example.com', true)).toBe(true);
    expect(removeKeyOffered('op@example.com', 'op@example.com', true)).toBe(false);
    expect(removeKeyOffered('bob@example.com', 'op@example.com', false)).toBe(false);
  });
});

describe('asked twice', () => {
  it('first in words that say nothing comes back', () => {
    expect(confirmText('Bob Leaver')).toContain("Remove Bob Leaver's encryption key?");
    expect(confirmText('Bob Leaver')).toContain('nothing can bring them back');
  });

  it('then by typing the name; a different name or a cancel is a no', () => {
    expect(promptText('Bob Leaver')).toBe("Type the person's name to confirm: Bob Leaver");
    expect(nameConfirmed('Bob Leaver', 'Bob Leaver')).toBe(true);
    expect(nameConfirmed('  Bob Leaver ', 'Bob Leaver')).toBe(true);
    expect(nameConfirmed('Someone Else', 'Bob Leaver')).toBe(false);
    expect(nameConfirmed('bob leaver', 'Bob Leaver')).toBe(false);
    expect(nameConfirmed('', 'Bob Leaver')).toBe(false);
    expect(nameConfirmed(null, 'Bob Leaver')).toBe(false);
  });
});

describe('the removal', () => {
  it('goes to the person’s keys route, their subject encoded', () => {
    expect(removeKeyPath('bob@example.com')).toBe('/api/admin/access/bob%40example.com/keys');
  });

  it('counts only a success the server says; otherwise its reason, or a plain one', () => {
    expect(removalOutcome(true, { success: true })).toEqual({ removed: true });
    expect(removalOutcome(true, {})).toEqual({ removed: false, error: 'Could not remove the key' });
    expect(
      removalOutcome(false, { error: 'Remove your own key from Preferences, not from here.' })
    ).toEqual({ removed: false, error: 'Remove your own key from Preferences, not from here.' });
    expect(removalOutcome(false, null)).toEqual({
      removed: false,
      error: 'Could not remove the key',
    });
  });

  it('says Removing… while it runs; a refusal or no answer leaves the reason by the button', () => {
    expect(buttonLabel(initialShred)).toBe('Remove key');
    expect(buttonLabel(fold([{ type: 'sent' }]))).toBe('Removing…');
    expect(fold([{ type: 'sent' }, { type: 'refused', error: 'No.' }])).toEqual({
      busy: false,
      error: 'No.',
    });
    expect(fold([{ type: 'sent' }, { type: 'unreachable' }])).toEqual({
      busy: false,
      error: 'Could not reach the server',
    });
  });

  it('a new try clears the last reason', () => {
    expect(fold([{ type: 'refused', error: 'No.' }, { type: 'sent' }]).error).toBeNull();
    expect(fold([{ type: 'sent' }, { type: 'removed' }])).toEqual(initialShred);
  });
});
