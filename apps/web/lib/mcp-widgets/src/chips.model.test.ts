/**
 * The chips combo box's rules (chips.model.ts), which the JSM create card's
 * Components field and every other many-option pick list send from. These
 * used to be driven through the card's iframe in a browser
 * (jsm-create-request-card.spec.ts); the spec now only checks that what the
 * field holds reaches the confirm tool as ids.
 */

import {
  chipLabel,
  chipsReducer,
  initialChips,
  matchOption,
  offeredOptions,
  type ChipsState,
} from './chips.model';

const OPTIONS = [
  { value: '10042', label: 'Billing' },
  { value: '10043', label: 'Platform' },
  { value: '10044', label: 'Mobile app' },
];

const start = (values: string[] = []) => initialChips(OPTIONS, values);
const labels = (state: ChipsState) => state.chosen.map((value) => chipLabel(state, value));
const offered = (state: ChipsState) => offeredOptions(state).map((option) => option.label);

describe('initialChips', () => {
  it('starts from the values the model passed, once each, in order', () => {
    const state = start(['10043', '10042', '10043']);
    expect(state.chosen).toEqual(['10043', '10042']);
    expect(labels(state)).toEqual(['Platform', 'Billing']);
  });

  it('shows a value no option names as itself', () => {
    expect(labels(start(['99999']))).toEqual(['99999']);
  });
});

describe('matchOption', () => {
  it('names an option by its label or value, ignoring case and spaces', () => {
    expect(matchOption(OPTIONS, '  platform ')?.value).toBe('10043');
    expect(matchOption(OPTIONS, '10044')?.label).toBe('Mobile app');
  });

  it('names nothing for a half-typed word or an empty box', () => {
    expect(matchOption(OPTIONS, 'Plat')).toBeUndefined();
    expect(matchOption(OPTIONS, '   ')).toBeUndefined();
  });
});

describe('chipsReducer', () => {
  it('adds the option a typed label names, newest last, and takes it off the list', () => {
    const state = chipsReducer(start(['10042']), { type: 'typed', text: 'Platform' });
    expect(labels(state)).toEqual(['Billing', 'Platform']);
    expect(offered(state)).toEqual(['Mobile app']);
  });

  it('leaves the state as it was for a partial word or an option already chosen', () => {
    const before = start(['10042']);
    expect(chipsReducer(before, { type: 'typed', text: 'Bil' })).toBe(before);
    expect(chipsReducer(before, { type: 'typed', text: 'billing' })).toBe(before);
  });

  it('takes a chip off with its × and offers it again, in option order', () => {
    const both = chipsReducer(start(['10042']), { type: 'typed', text: 'Platform' });
    const removed = chipsReducer(both, { type: 'remove', value: '10042' });
    expect(labels(removed)).toEqual(['Platform']);
    expect(offered(removed)).toEqual(['Billing', 'Mobile app']);
    // Picked again, it goes on the end: the card sends the order picked.
    const again = chipsReducer(removed, { type: 'typed', text: 'billing' });
    expect(again.chosen).toEqual(['10043', '10042']);
  });

  it('ignores a × for a value no longer chosen', () => {
    const before = start(['10042']);
    expect(chipsReducer(before, { type: 'remove', value: '10043' })).toBe(before);
  });

  it('takes the newest chip off on Backspace, and does nothing with none left', () => {
    const state = chipsReducer(start(['10042', '10043']), { type: 'backspace' });
    expect(state.chosen).toEqual(['10042']);
    const empty = chipsReducer(state, { type: 'backspace' });
    expect(empty.chosen).toEqual([]);
    expect(chipsReducer(empty, { type: 'backspace' })).toBe(empty);
  });
});
