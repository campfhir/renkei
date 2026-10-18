/**
 * The payload boundary's rejections, which are the only words a caller
 * writing a definition by hand (over MCP, or against the REST routes) gets:
 * a draft that fails the structural guard never reaches the validator's
 * per-path messages, so the reason has to travel with the refusal.
 *
 * Entries here are always {draft, enabled} — the MCP tools wrap a bare
 * draft into one before calling this.
 */

import { parseAgentPayload } from './payload';

const DEFINITION = { instructions: '## Goal\n\nSend the weekly digest.', tools: [] };

const body = (drafts: unknown[]) => ({
  name: 'Weekly digest',
  ...DEFINITION,
  triggers: drafts.map((draft) => ({ draft })),
});

const errorFor = (drafts: unknown[]): string => {
  const parsed = parseAgentPayload(body(drafts));
  if (!('error' in parsed)) throw new Error('expected the payload to be rejected');
  return parsed.error;
};

describe('parseAgentPayload on triggers', () => {
  it('accepts the weekly form a named day needs, and honours enabled', () => {
    const parsed = parseAgentPayload({
      name: 'Weekly digest',
      ...DEFINITION,
      triggers: [
        {
          draft: {
            kind: 'schedule',
            recurrences: [{ every: 'week', weekday: 0, at: '09:00' }],
            timezone: 'America/Chicago',
          },
        },
        {
          draft: { kind: 'api', inputs: [{ name: 'ticket', label: 'Ticket' }] },
          enabled: false,
        },
      ],
    });
    if ('error' in parsed) throw new Error(`expected the payload to parse: ${parsed.error}`);
    expect(parsed.input.triggers.map((trigger) => trigger.enabled)).toEqual([true, false]);
  });

  it('tells a caller who sent a bare draft which shape an entry takes', () => {
    const parsed = parseAgentPayload({
      name: 'Weekly digest',
      ...DEFINITION,
      triggers: [{ kind: 'api', inputs: [] }],
    });
    if (!('error' in parsed)) throw new Error('expected the payload to be rejected');
    expect(parsed.error).toBe('Trigger 1 needs a "draft" — an entry is {draft, enabled}');
  });

  it('says which trigger, which key, and what the key accepts', () => {
    expect(
      errorFor([
        { kind: 'schedule', recurrences: [{ every: 'day', at: '09:00' }], timezone: 'UTC' },
        { kind: 'schedule', recurrences: [{ every: 'sunday' }], timezone: 'UTC' },
      ])
    ).toBe(
      'Trigger 2: recurrence 1: "every" must be "hour", "day", "weekday", "week" or "month" ' +
        '(got "sunday")'
    );
  });

  it('names the kinds for a draft that is not one of them', () => {
    const error = errorFor([{ kind: 'webhook' }]);
    expect(error).toContain('Trigger 1');
    expect(error).toContain('"kind"');
    expect(error).toContain('"event"');
  });

  it('rejects a non-object entry by saying what an entry is', () => {
    const parsed = parseAgentPayload({
      name: 'Weekly digest',
      ...DEFINITION,
      triggers: ['every sunday at 9'],
    });
    if (!('error' in parsed)) throw new Error('expected the payload to be rejected');
    expect(parsed.error).toBe('Trigger 1 must be a {draft, enabled} entry');
  });
});

describe('parseAgentPayload on the definition', () => {
  it('needs the instructions as text and the tools as a list of names', () => {
    const missing = parseAgentPayload({ name: 'X', tools: [], triggers: [] });
    expect(missing).toEqual({ error: expect.stringContaining('instructions is required') });
    const badTools = parseAgentPayload({
      name: 'X',
      instructions: 'Go.',
      tools: [1],
      triggers: [],
    });
    expect(badTools).toEqual({ error: 'tools must be a list of tool names' });
  });

  it('carries auto-accept and questions through, off unless said', () => {
    const parsed = parseAgentPayload({ ...body([]), autoAcceptActions: true });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.draft.autoAcceptActions).toBe(true);
    expect(parsed.draft.canAskQuestions).toBe(false);
  });
});
