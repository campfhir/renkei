/**
 * The dynamic form vocabulary an `ask_person` call builds at run time —
 * structural checks only (the answer-value rules live in
 * question-answers.ts, which reads the flattened field list this module
 * hands back).
 */

import {
  countFormNodes,
  flattenFormFields,
  isFormNode,
  MAX_FORM_NODES,
  parseFormNodes,
  type FormNode,
} from './question-form';

const paragraph = (text: string): FormNode => ({ kind: 'paragraph', text });
const field = (name: string): FormNode => ({
  kind: 'field',
  name,
  label: name,
  type: 'text',
  required: false,
});
const group = (label: string, nodes: FormNode[]): FormNode => ({ kind: 'group', label, nodes });

describe('isFormNode', () => {
  it('accepts a field, a paragraph, and a one-level group of both', () => {
    expect(isFormNode(field('a'))).toBe(true);
    expect(isFormNode(paragraph('context'))).toBe(true);
    expect(isFormNode(group('Question 1', [paragraph('why'), field('answer')]))).toBe(true);
  });

  it('refuses a group nested inside a group — one level only', () => {
    const nested = group('outer', [group('inner', [field('a')])]);
    expect(isFormNode(nested)).toBe(false);
  });

  it('refuses anything that is not one of the three shapes', () => {
    expect(isFormNode({ kind: 'field', name: 'a' })).toBe(false); // missing required QuestionField parts
    expect(isFormNode({ kind: 'paragraph' })).toBe(false); // missing text
    expect(isFormNode({ kind: 'group', label: 'x' })).toBe(false); // missing nodes
    expect(isFormNode(null)).toBe(false);
    expect(isFormNode('a string')).toBe(false);
  });
});

describe('parseFormNodes', () => {
  it('drops malformed entries rather than throwing, so a bad card still renders', () => {
    const raw = [field('a'), { kind: 'nonsense' }, paragraph('ok'), null, 42];
    expect(parseFormNodes(raw)).toEqual([field('a'), paragraph('ok')]);
  });

  it('is a no-op on non-array input', () => {
    expect(parseFormNodes('nope')).toEqual([]);
    expect(parseFormNodes(undefined)).toEqual([]);
  });

  it('caps at MAX_FORM_NODES top-level entries', () => {
    const many = Array.from({ length: MAX_FORM_NODES + 10 }, (_, i) => field(`f${i}`));
    expect(parseFormNodes(many)).toHaveLength(MAX_FORM_NODES);
  });
});

describe('flattenFormFields', () => {
  it('collects top-level fields and fields inside one group, skipping paragraphs', () => {
    const form: FormNode[] = [
      paragraph('Two things need your input this week.'),
      group('CRC/XCure KPI', [
        paragraph('The Aug 22 note says 79% -> 90%.'),
        field('the issue key'),
      ]),
      field('a second, unrelated field'),
    ];
    expect(flattenFormFields(form).map((f) => f.name)).toEqual([
      'the issue key',
      'a second, unrelated field',
    ]);
  });

  it('returns an empty list for a form of only paragraphs', () => {
    expect(flattenFormFields([paragraph('just context, no fields')])).toEqual([]);
  });
});

describe('countFormNodes', () => {
  it('counts a group as itself plus its members', () => {
    const form: FormNode[] = [paragraph('p'), group('g', [field('a'), field('b')])];
    // paragraph (1) + group (1) + its two fields (2) = 4
    expect(countFormNodes(form)).toBe(4);
  });
});
