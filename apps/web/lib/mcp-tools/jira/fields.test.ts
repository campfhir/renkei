import { normalizeFieldId, renderFieldValue } from './fields';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const paragraph = (value: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});

describe('renderFieldValue', () => {
  it('never yields [object Object] for an ADF description', () => {
    const rendered = renderFieldValue(doc(paragraph('Deploy the schema change.')));
    expect(rendered).toBe('Deploy the schema change.');
    expect(rendered).not.toContain('[object Object]');
  });

  it('keeps the markdown the renderer produces', () => {
    const rendered = renderFieldValue(
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('step one')] }] })
    );
    expect(rendered).toBe('- step one');
  });

  it('unwraps a select field to its value', () => {
    expect(renderFieldValue({ self: 'https://x.test/f/1', value: 'Approved', id: '10201' })).toBe(
      'Approved'
    );
  });

  it('joins the two levels of a cascading select', () => {
    expect(renderFieldValue({ value: 'Infrastructure', child: { value: 'Network' } })).toBe(
      'Infrastructure → Network'
    );
  });

  it('unwraps users, and the shared name shape', () => {
    expect(renderFieldValue({ accountId: 'abc', displayName: 'Dana Lin' })).toBe('Dana Lin');
    expect(renderFieldValue({ name: 'In Progress', id: '3' })).toBe('In Progress');
  });

  it('comma-joins arrays of options', () => {
    expect(renderFieldValue([{ value: 'Low' }, { value: 'Reversible' }])).toBe('Low, Reversible');
  });

  it('bullets arrays whose members span lines', () => {
    const multi = doc(paragraph('one'), paragraph('two'));
    expect(renderFieldValue([multi, 'plain'])).toBe('- one\n\ntwo\n- plain');
  });

  it('passes through scalars and drops empties', () => {
    expect(renderFieldValue('  spaced  ')).toBe('spaced');
    expect(renderFieldValue(7)).toBe('7');
    expect(renderFieldValue(false)).toBe('false');
    expect(renderFieldValue(null)).toBe('');
    expect(renderFieldValue(undefined)).toBe('');
    expect(renderFieldValue([])).toBe('');
  });

  it('shows the raw payload for a shape it does not recognise', () => {
    const rendered = renderFieldValue({ originalEstimateSeconds: 3600, remaining: null });
    expect(rendered).toContain('originalEstimateSeconds');
    expect(rendered).not.toContain('[object Object]');
  });
});

describe('normalizeFieldId', () => {
  it('expands a bare custom field number', () => {
    expect(normalizeFieldId('12013')).toBe('customfield_12013');
  });

  it('expands the JQL cf[] spelling', () => {
    expect(normalizeFieldId('cf[12016]')).toBe('customfield_12016');
    expect(normalizeFieldId('CF[12016]')).toBe('customfield_12016');
  });

  it('leaves ids and system field names alone', () => {
    expect(normalizeFieldId('customfield_12013')).toBe('customfield_12013');
    expect(normalizeFieldId(' labels ')).toBe('labels');
    expect(normalizeFieldId('*all')).toBe('*all');
  });
});
