/**
 * The trigger patch: what a caller can change one trigger at a time, and
 * what it refuses so an edit never becomes a delete nobody asked for.
 */

import { applyTriggerPatch, toTriggerOperations, type ExistingTrigger } from './patch-triggers';

const schedule: ExistingTrigger = {
  id: 'trigger-schedule',
  draft: { kind: 'schedule', recurrences: [{ every: 'day', at: '09:00' }], timezone: 'UTC' },
  enabled: true,
};
const event: ExistingTrigger = {
  id: 'trigger-event',
  draft: { kind: 'event', eventId: 'microsoft/mail.received' },
  enabled: true,
};

describe('applyTriggerPatch', () => {
  it('retimes one trigger and leaves the others byte-identical', () => {
    // The case the tool exists for: changing the schedule used to mean
    // echoing every other trigger back, where a forgotten one is a delete.
    const result = applyTriggerPatch(
      [schedule, event],
      [
        {
          op: 'update',
          id: 'trigger-schedule',
          draft: {
            kind: 'schedule',
            recurrences: [{ every: 'week', weekday: 1, at: '07:30' }],
            timezone: 'America/Chicago',
          },
        },
      ]
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.triggers).toHaveLength(2);
    expect(result.triggers[0]).toEqual({
      id: 'trigger-schedule',
      draft: {
        kind: 'schedule',
        recurrences: [{ every: 'week', weekday: 1, at: '07:30' }],
        timezone: 'America/Chicago',
      },
      enabled: true,
    });
    expect(result.triggers[1]).toEqual({ id: 'trigger-event', draft: event.draft, enabled: true });
  });

  it('turns one trigger off without touching what it fires on', () => {
    const result = applyTriggerPatch(
      [schedule],
      [{ op: 'update', id: 'trigger-schedule', enabled: false }]
    );
    expect(result.ok && result.triggers[0]).toEqual({ ...schedule, enabled: false });
  });

  it('adds without an id, so the server mints one', () => {
    const draft = { kind: 'api' as const, inputs: [{ name: 'ticket', label: 'Ticket' }] };
    const result = applyTriggerPatch([schedule], [{ op: 'add', draft, enabled: true }]);
    expect(result.ok && result.triggers).toEqual([
      { id: 'trigger-schedule', draft: schedule.draft, enabled: true },
      { draft, enabled: true },
    ]);
  });

  it('removes by id and keeps the rest', () => {
    const result = applyTriggerPatch([schedule, event], [{ op: 'remove', id: 'trigger-event' }]);
    expect(result.ok && result.triggers.map((trigger) => trigger.id)).toEqual(['trigger-schedule']);
  });

  it('names the ids it does know when one is not found', () => {
    const result = applyTriggerPatch([schedule], [{ op: 'remove', id: 'trigger-nope' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"trigger-nope"');
    expect(result.error).toContain('"trigger-schedule" (schedule)');
  });

  it('refuses to change a trigger’s kind in place', () => {
    // reconcileTriggers would drop the row and insert a new one: the
    // firings and the API key would go with it, silently.
    const result = applyTriggerPatch(
      [schedule],
      [
        {
          op: 'update',
          id: 'trigger-schedule',
          draft: { kind: 'event', eventId: 'microsoft/mail.received' },
        },
      ]
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('is a schedule trigger');
    expect(result.error).toContain('remove it and add the new one');
  });

  it('applies nothing when a later operation cannot be applied', () => {
    const result = applyTriggerPatch(
      [schedule],
      [
        { op: 'remove', id: 'trigger-schedule' },
        { op: 'remove', id: 'trigger-event' },
      ]
    );
    expect(result.ok).toBe(false);
  });

  it('insists an update says what to change', () => {
    const result = applyTriggerPatch([schedule], [{ op: 'update', id: 'trigger-schedule' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"draft"');
  });
});

describe('toTriggerOperations', () => {
  it('carries the recurrence reason for a bad draft', () => {
    const result = toTriggerOperations([
      {
        op: 'update',
        id: 'trigger-schedule',
        draft: { kind: 'schedule', recurrences: [{ every: 'sunday' }], timezone: 'UTC' },
      },
    ]);
    expect('error' in result && result.error).toContain('"every" must be');
    expect('error' in result && result.error).toContain('"week"');
  });

  it('points a bare draft at the operation shape', () => {
    const result = toTriggerOperations([{ kind: 'schedule', recurrences: [], timezone: 'UTC' }]);
    expect('error' in result && result.error).toContain('op must be');
    expect('error' in result && result.error).toContain('{op:"update"');
  });

  it('requires an id for update and remove, but not for add', () => {
    expect(
      'error' in toTriggerOperations([{ op: 'update', draft: { kind: 'api', inputs: [] } }])
    ).toBe(true);
    expect('error' in toTriggerOperations([{ op: 'remove' }])).toBe(true);
    expect(toTriggerOperations([{ op: 'add', draft: { kind: 'api', inputs: [] } }])).toEqual({
      val: [{ op: 'add', draft: { kind: 'api', inputs: [] }, enabled: true }],
    });
  });

  it('keeps an update minimal — an omitted key is not a change to it', () => {
    expect(toTriggerOperations([{ op: 'update', id: 'a', enabled: false }])).toEqual({
      val: [{ op: 'update', id: 'a', enabled: false }],
    });
  });

  it('refuses an empty list rather than saving nothing quietly', () => {
    expect('error' in toTriggerOperations([])).toBe(true);
  });
});
