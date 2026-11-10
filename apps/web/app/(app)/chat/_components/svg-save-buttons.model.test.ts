import { NOT_AN_SVG } from '@/lib/svg-image';
import {
  announcement,
  buttonFor,
  canStart,
  errorText,
  initSvgSave,
  svgSaveReducer,
  type SvgSaveAction,
} from './svg-save-buttons.model';

const after = (...actions: SvgSaveAction[]) => actions.reduce(svgSaveReducer, initSvgSave());

describe('Save as PNG / SVG', () => {
  it('offers both formats, by name, ready to press', () => {
    const state = initSvgSave();
    expect(buttonFor(state, 'png')).toEqual({
      label: 'Save as PNG',
      text: 'PNG',
      icon: 'download',
      disabled: false,
    });
    expect(buttonFor(state, 'svg').label).toBe('Save as SVG');
    expect(announcement(state)).toBe('');
    expect(errorText(state)).toBeNull();
  });

  it('takes no second press while a save is running: both buttons are off', () => {
    const saving = after({ type: 'started' });
    expect(canStart(saving)).toBe(false);
    expect(buttonFor(saving, 'png').disabled).toBe(true);
    expect(buttonFor(saving, 'svg').disabled).toBe(true);
  });

  it('a save confirms on its own button only, and is announced', () => {
    const saved = after({ type: 'started' }, { type: 'saved', format: 'png' });
    expect(canStart(saved)).toBe(true);
    expect(buttonFor(saved, 'png')).toMatchObject({ text: 'Saved', icon: 'check' });
    expect(buttonFor(saved, 'svg')).toMatchObject({ text: 'SVG', icon: 'download' });
    expect(announcement(saved)).toBe('Saved as PNG');
  });

  it('"Saved" goes back to the format after a moment', () => {
    const settled = after(
      { type: 'started' },
      { type: 'saved', format: 'svg' },
      { type: 'saved-shown' }
    );
    expect(buttonFor(settled, 'svg').text).toBe('SVG');
    expect(announcement(settled)).toBe('');
  });

  it('a truncated SVG says so instead of saving something broken', () => {
    const refused = after({ type: 'started' }, { type: 'failed', message: NOT_AN_SVG });
    expect(errorText(refused)).toContain('not a complete, valid SVG');
    expect(canStart(refused)).toBe(true);
  });

  it('a failure with nothing to say still says the image could not be saved', () => {
    expect(errorText(after({ type: 'started' }, { type: 'failed', message: null }))).toBe(
      'The image could not be saved.'
    );
  });

  it('the reason stays until the next save works, and the moment passing does not clear it', () => {
    const refused = after({ type: 'failed', message: 'nope' }, { type: 'saved-shown' });
    expect(errorText(refused)).toBe('nope');
    expect(errorText(svgSaveReducer(refused, { type: 'saved', format: 'png' }))).toBeNull();
  });
});
