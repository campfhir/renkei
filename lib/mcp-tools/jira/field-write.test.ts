import {
  fieldErrorsOf,
  refusedFields,
  unwrittenFieldsComment,
  writeWithFieldFallback,
  type FieldWritePlan,
} from './field-write';

/** Jira's 400 as jiraFetch surfaces it. */
const refusal = (fields: Record<string, string>, message = 'Jira API 400: field cannot be set') =>
  Object.assign(new Error(message), { status: 400, fieldErrors: fields });

const plan = (over: Partial<FieldWritePlan> = {}): FieldWritePlan => ({
  required: {},
  optional: {},
  labels: {},
  ...over,
});

describe('fieldErrorsOf', () => {
  it('reads the map off an error that carries one', () => {
    expect(fieldErrorsOf(refusal({ customfield_1: 'nope' }))).toEqual({ customfield_1: 'nope' });
  });

  it('is empty for anything else', () => {
    expect(fieldErrorsOf(new Error('plain'))).toEqual({});
    expect(fieldErrorsOf(null)).toEqual({});
    expect(fieldErrorsOf('string')).toEqual({});
  });
});

describe('refusedFields', () => {
  const optional = { customfield_1: 1, priority: { name: 'High' } };

  it('names only the droppable fields the error blames', () => {
    const error = refusal({ customfield_1: 'nope', summary: 'also bad' });
    expect(refusedFields(error, optional)).toEqual(['customfield_1']);
  });

  it('finds a field named only in the message', () => {
    const error = new Error("Jira API 400: Field 'customfield_1' cannot be set.");
    expect(refusedFields(error, optional)).toEqual(['customfield_1']);
  });

  it('blames nothing when the error is about a field that is not droppable', () => {
    expect(refusedFields(refusal({ issuetype: 'unknown' }), optional)).toEqual([]);
  });

  it('does not read a built-in id appearing as an ordinary word as blame', () => {
    // The words are in the prose, not named as fields — dropping either would be
    // acting on a coincidence.
    const error = new Error('Jira API 403: you cannot edit the priority or the summary here');
    expect(refusedFields(error, { priority: 1, summary: 'x' })).toEqual([]);
  });

  it('reads a quoted built-in id as blame', () => {
    const error = new Error("Jira API 400: Field 'priority' cannot be set.");
    expect(refusedFields(error, { priority: 1, summary: 'x' })).toEqual(['priority']);
  });

  it('blames nothing when there is nothing droppable', () => {
    expect(refusedFields(refusal({ customfield_1: 'nope' }), {})).toEqual([]);
  });
});

describe('writeWithFieldFallback', () => {
  it('sends once when nothing is refused', async () => {
    const send = jest.fn(async () => 'ok');
    const outcome = await writeWithFieldFallback(
      plan({ required: { summary: 'x' }, optional: { customfield_1: 5 } }),
      send
    );

    expect(outcome).toMatchObject({ result: 'ok', sent: true, attempts: 1, dropped: [] });
    expect(send).toHaveBeenCalledWith({ summary: 'x', customfield_1: 5 });
  });

  it('drops a refused field and retries with the rest', async () => {
    const send = jest.fn(async (fields: Record<string, unknown>) => {
      if ('customfield_1' in fields) throw refusal({ customfield_1: 'not on screen' });
      return 'ok';
    });

    const outcome = await writeWithFieldFallback(
      plan({
        required: { summary: 'x' },
        optional: { customfield_1: 5 },
        labels: { customfield_1: 'Story Points → 5' },
      }),
      send
    );

    expect(outcome.attempts).toBe(2);
    expect(outcome.dropped).toEqual([{ label: 'Story Points → 5', reason: 'not on screen' }]);
    expect(send).toHaveBeenLastCalledWith({ summary: 'x' });
  });

  it('keeps dropping until what remains is accepted', async () => {
    const send = jest.fn(async (fields: Record<string, unknown>) => {
      const bad = ['a', 'b', 'c'].filter((key) => key in fields);
      if (bad.length > 0) throw refusal({ [bad[0]!]: 'nope' });
      return 'ok';
    });

    const outcome = await writeWithFieldFallback(
      plan({ required: { summary: 'x' }, optional: { a: 1, b: 2, c: 3 } }),
      send
    );

    // One attempt per refused field, plus the one that succeeds.
    expect(outcome.attempts).toBe(4);
    expect(outcome.dropped.map((field) => field.label)).toEqual(['a', 'b', 'c']);
  });

  it('rethrows an error that blames nothing droppable, without retrying', async () => {
    const send = jest.fn(async () => {
      throw refusal({ issuetype: 'unknown issue type' });
    });

    await expect(
      writeWithFieldFallback(plan({ required: { issuetype: 'x' }, optional: { a: 1 } }), send)
    ).rejects.toThrow('field cannot be set');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('makes no request at all once nothing sendable is left', async () => {
    const send = jest.fn(async (fields: Record<string, unknown>) => {
      if ('a' in fields) throw refusal({ a: 'nope' });
      return 'ok';
    });

    const outcome = await writeWithFieldFallback(plan({ optional: { a: 1 } }), send);

    // The empty payload is never sent: Jira would reject it anyway.
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ result: null, sent: false, attempts: 1 });
    expect(outcome.dropped).toHaveLength(1);
  });

  it('sends nothing when there was nothing to send', async () => {
    const send = jest.fn(async () => 'ok');
    const outcome = await writeWithFieldFallback(plan(), send);

    expect(send).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ sent: false, attempts: 0 });
  });
});

describe('unwrittenFieldsComment', () => {
  it('says what the value was and why it is not in its field', () => {
    const comment = unwrittenFieldsComment([
      { label: 'Story Points → 5', reason: 'not on the appropriate screen' },
    ]);

    expect(comment).toContain('**Story Points → 5**');
    expect(comment).toContain('not on the appropriate screen');
    expect(comment).toContain('so the value is not lost');
  });
});
