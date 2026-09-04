/**
 * knowledge_create_note (and the other tools sharing this field) failed
 * outright for an agent that wrote `keywords` as one comma-separated string
 * instead of a JSON array — a model mistake this schema now normalizes
 * rather than rejects. It used to reach zod's array schema as the wrong
 * top-level type, which — a real zod quirk, not just an unhelpful message —
 * also evaluated the array's `.max()` against the string's own `.length`,
 * reporting a second, misleading "<=20 characters" issue alongside the
 * first.
 */

import { z } from 'zod';
import { keywordsFieldSchema } from './common';

const schema = z.object({ keywords: keywordsFieldSchema('test field') });

async function parse(input: unknown) {
  const result = await schema['~standard'].validate(input);
  if (result.issues) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe('keywordsFieldSchema', () => {
  it('splits a comma-separated string into members', async () => {
    await expect(parse({ keywords: 'foo, bar,  baz ' })).resolves.toEqual({
      keywords: ['foo', 'bar', 'baz'],
    });
  });

  it('accepts an array unchanged', async () => {
    await expect(parse({ keywords: ['foo', 'bar'] })).resolves.toEqual({
      keywords: ['foo', 'bar'],
    });
  });

  it('stays optional when omitted', async () => {
    await expect(parse({})).resolves.toEqual({});
  });

  it('drops empty entries from a trailing or doubled comma', async () => {
    await expect(parse({ keywords: 'foo,,bar,' })).resolves.toEqual({
      keywords: ['foo', 'bar'],
    });
  });

  it('still rejects the wrong type outright, with one clear issue', async () => {
    const result = await schema['~standard'].validate({ keywords: 42 });
    expect(result.issues).toHaveLength(1);
  });
});
