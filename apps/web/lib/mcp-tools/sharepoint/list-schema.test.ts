import { columnDefinition, internalNameFor, type ColumnSpec } from './list-schema';

const build = (spec: Partial<ColumnSpec>) =>
  columnDefinition({ displayName: 'Column', type: 'text', ...spec });

describe('a column spec becomes Graph’s column definition', () => {
  it('derives an internal name people will not have to spell as _x0020_', () => {
    expect(internalNameFor('Due Date')).toBe('DueDate');
    expect(internalNameFor('2026 Budget (USD)')).toBe('BudgetUSD');
    expect(internalNameFor('A'.repeat(40))).toHaveLength(32);
  });

  it('keeps an internal name the caller chose', () => {
    expect(build({ displayName: 'Due Date', name: 'Due_On' })).toEqual({
      ok: true,
      body: { name: 'Due_On', displayName: 'Due Date', text: {} },
    });
  });

  it('asks for a name when the display name has no letters to make one from', () => {
    const result = build({ displayName: '£ 2026' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('give one as `name`');
  });

  it('refuses a second Title or ID column', () => {
    expect(build({ displayName: 'Title' }).ok).toBe(false);
    expect(build({ displayName: 'Item', name: 'ID' }).ok).toBe(false);
  });

  it('gives each type its facet', () => {
    const facetOf = (type: ColumnSpec['type'], choices?: string[]) => {
      const result = build({ type, choices });
      if (!result.ok) throw new Error(result.error);
      const { name: _n, displayName: _d, ...facet } = result.body;
      return facet;
    };
    expect(facetOf('multilineText')).toEqual({ text: { allowMultipleLines: true } });
    expect(facetOf('number')).toEqual({ number: {} });
    expect(facetOf('currency')).toEqual({ currency: {} });
    expect(facetOf('dateTime')).toEqual({ dateTime: { format: 'dateTime' } });
    expect(facetOf('dateOnly')).toEqual({ dateTime: { format: 'dateOnly' } });
    expect(facetOf('boolean')).toEqual({ boolean: {} });
    expect(facetOf('hyperlink')).toEqual({ hyperlinkOrPicture: { isPicture: false } });
    expect(facetOf('multiChoice', ['A', 'B'])).toEqual({
      choice: { choices: ['A', 'B'], displayAs: 'checkBoxes', allowTextEntry: false },
    });
  });

  it('wants choices on a choice column and nowhere else', () => {
    expect(build({ type: 'choice', choices: [' ', ''] }).ok).toBe(false);
    expect(build({ type: 'number', choices: ['1'] }).ok).toBe(false);
  });

  it('carries required, indexed and help text only when set', () => {
    expect(build({ required: true, indexed: true, description: '  What is due  ' })).toEqual({
      ok: true,
      body: {
        name: 'Column',
        displayName: 'Column',
        description: 'What is due',
        required: true,
        indexed: true,
        text: {},
      },
    });
  });
});
