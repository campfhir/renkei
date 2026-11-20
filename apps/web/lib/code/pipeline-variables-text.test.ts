/**
 * The variable box made ready for one value: a variable with no line gets
 * `KEY=` (or `secret KEY=`) at the end with the cursor after the `=`; one
 * with a line keeps it, its value selected so typing replaces it.
 */

import { withVariableLine } from './pipeline-variables-text';

it('adds a missing variable as `KEY=` at the end, the cursor after the `=`', () => {
  const ready = withVariableLine('API_URL=https://x.test\n\n', 'REGION', false);
  expect(ready.text).toBe('API_URL=https://x.test\nREGION=');
  expect(ready.caret).toEqual({ start: ready.text.length, end: ready.text.length });
});

it('adds a missing secret as `secret KEY=`, and starts an empty box with it', () => {
  expect(withVariableLine('', 'DEPLOY_TOKEN', true)).toEqual({
    text: 'secret DEPLOY_TOKEN=',
    caret: { start: 20, end: 20 },
  });
});

it('goes to a variable that has a line, selecting its value', () => {
  const text = 'API_URL=https://x.test\nREGION=us-east-1\nsecret DEPLOY_TOKEN=';
  const region = withVariableLine(text, 'REGION', false);
  expect(region.text).toBe(text);
  expect(text.slice(region.caret.start, region.caret.end)).toBe('us-east-1');
  const token = withVariableLine(text, 'DEPLOY_TOKEN', true);
  expect(token.caret).toEqual({ start: text.length, end: text.length });
});

it('does not take a longer key for the one asked', () => {
  const ready = withVariableLine('REGION_NAME=west', 'REGION', false);
  expect(ready.text).toBe('REGION_NAME=west\nREGION=');
});
