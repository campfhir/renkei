/**
 * Who a connector is for (audience-control.tsx), with no network or React:
 * which choice is shown, what each change saves (choosing Everyone with
 * groups named saves an empty list; picking "only these groups" saves
 * nothing until a group is added), what the hint above says about where
 * groups come from, and what a save leaves on screen. Tested in
 * audience-control.model.test.ts.
 */

import { recordOrNull } from '@renkei/guards';

export type AudienceMode = 'everyone' | 'groups';

export interface AudienceState {
  mode: AudienceMode;
  values: string[];
  busy: boolean;
  notice: string | null;
  error: string | null;
}

export type AudienceAction =
  | { type: 'choose'; mode: AudienceMode }
  | { type: 'values'; values: string[] }
  | { type: 'saving' }
  | { type: 'saved'; notice: string }
  | { type: 'save-failed'; error: string };

/** A rule already on file opens on "only these groups"; none, on Everyone. */
export function initialAudience(values: string[]): AudienceState {
  return {
    mode: values.length > 0 ? 'groups' : 'everyone',
    values,
    busy: false,
    notice: null,
    error: null,
  };
}

export function audienceReducer(state: AudienceState, action: AudienceAction): AudienceState {
  switch (action.type) {
    case 'choose':
      // Everyone means no groups: the list empties with the choice.
      return action.mode === 'everyone'
        ? { ...state, mode: 'everyone', values: [] }
        : { ...state, mode: 'groups' };
    case 'values':
      return { ...state, values: action.values };
    case 'saving':
      return { ...state, busy: true, notice: null, error: null };
    case 'saved':
      return { ...state, busy: false, notice: action.notice };
    case 'save-failed':
      return { ...state, busy: false, error: action.error };
  }
}

/**
 * The list a change saves, or null when it saves nothing: choosing
 * Everyone saves an empty list only when groups were named, and choosing
 * groups saves nothing until one is added; every edit of the list saves it.
 */
export function savesOnChoose(state: AudienceState, mode: AudienceMode): string[] | null {
  if (mode === 'everyone' && state.values.length > 0) return [];
  return null;
}

/** What a good save says. */
export function savedNotice(values: readonly string[], label: string): string {
  if (values.length === 0) return 'Saved. Offered to everyone again.';
  const groups = `${values.length} group${values.length === 1 ? '' : 's'}`;
  return `Saved. Only people in ${groups} are offered ${label}; tool lists refresh within a minute.`;
}

/** What a refused save says: the route's error, or a plain fallback. */
export function failedSave(body: unknown): string {
  const record = recordOrNull(body);
  return record && 'error' in record ? String(record.error) : 'Could not save';
}

/**
 * Where groups come from, above the choice. With no groups claim nobody is
 * in any group, so a restricted audience closes the connector to everyone.
 */
export function claimHint(
  groupsClaim: string | null,
  observedGroups: number
): { kind: 'no-claim' } | { kind: 'claim'; claim: string; seen: string } {
  if (groupsClaim === null) return { kind: 'no-claim' };
  return {
    kind: 'claim',
    claim: groupsClaim,
    seen: `${observedGroups} distinct value${observedGroups === 1 ? '' : 's'} seen so far.`,
  };
}
