/**
 * triggerVariableDescriptors: every trigger kind contributes its variables
 * with descriptions, names dedupe across triggers, and triggerVariableNames
 * stays the descriptor list's name projection.
 *
 * Plus the wire guard, which is the boundary an event trigger's `match`
 * crosses on its way to the fan-out's hot path.
 */

import {
  isTriggerDraft,
  triggerVariableDescriptors,
  triggerVariableNames,
  validateTriggerDrafts,
  type TriggerDraft,
} from './triggers';
import { triggerEventById } from './trigger-catalog';

describe('triggerVariableDescriptors', () => {
  it('returns the catalog descriptors for an event trigger', () => {
    const drafts: TriggerDraft[] = [{ kind: 'event', eventId: 'webex/message.received' }];
    const descriptors = triggerVariableDescriptors(drafts);
    expect(descriptors).toEqual(triggerEventById('webex/message.received')?.provides);
    const roomId = descriptors.find((descriptor) => descriptor.name === 'trigger.roomId');
    expect(roomId?.description).toContain('webex_send_message');
  });

  it('describes api inputs, agent chaining, and schedules', () => {
    const drafts: TriggerDraft[] = [
      { kind: 'api', inputs: [{ name: 'ticket', label: 'Ticket key' }] },
      { kind: 'agent', callerAgentId: '00000000-0000-0000-0000-000000000000' },
      { kind: 'schedule', recurrences: [], timezone: 'UTC' },
    ];
    const byName = new Map(
      triggerVariableDescriptors(drafts).map((descriptor) => [descriptor.name, descriptor])
    );
    expect(byName.get('trigger.ticket')?.label).toBe('Ticket key');
    expect(byName.get('trigger.parentSummary')?.description).toContain('triggering agent');
    expect(byName.get('trigger.scheduledFor')?.description).toContain('scheduled');
  });

  it('dedupes by name across triggers and mirrors triggerVariableNames', () => {
    const drafts: TriggerDraft[] = [
      { kind: 'event', eventId: 'webex/message.received' },
      { kind: 'event', eventId: 'webex/message.received' },
    ];
    const descriptors = triggerVariableDescriptors(drafts);
    expect(new Set(descriptors.map((descriptor) => descriptor.name)).size).toBe(descriptors.length);
    expect(triggerVariableNames(drafts)).toEqual(descriptors.map((descriptor) => descriptor.name));
  });
});

describe('isTriggerDraft on an event trigger', () => {
  const eventId = 'microsoft/mail.received';

  it('accepts a draft with no filters, and one with usable filters', () => {
    expect(isTriggerDraft({ kind: 'event', eventId })).toBe(true);
    expect(
      isTriggerDraft({ kind: 'event', eventId, match: { fromDomain: 'customer.example' } })
    ).toBe(true);
    expect(
      isTriggerDraft({ kind: 'event', eventId, match: { fromAddresses: ['a@b.example'] } })
    ).toBe(true);
  });

  it.each([
    ['a number where a filter should be', { fromDomain: 42 }],
    ['objects inside a list', { roomIds: [{}] }],
    ['an array for the whole match', ['nope']],
    ['a string for the whole match', 'nope'],
  ])('refuses %s', (_label, match) => {
    // Before this guard an arbitrary object rode through the payload parser
    // into agent_triggers.config and on to the fan-out.
    expect(isTriggerDraft({ kind: 'event', eventId, match })).toBe(false);
  });
});

describe('validateTriggerDrafts reports filter problems against the catalog', () => {
  const eventId = 'microsoft/mail.received';

  it('keeps the original wording for a bad sender domain', () => {
    expect(
      validateTriggerDrafts([{ kind: 'event', eventId, match: { fromDomain: 'not a domain' } }])
    ).toEqual([{ index: 0, message: 'The sender domain filter is not a valid domain.' }]);
  });

  it('reports a bad address and carries the draft index', () => {
    const issues = validateTriggerDrafts([
      { kind: 'event', eventId },
      { kind: 'event', eventId, match: { fromAddresses: ['nope'] } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.index).toBe(1);
  });

  it('accepts a filter on an event that offers none', () => {
    // Fail open: a filter the catalog no longer knows must not block a save.
    expect(
      validateTriggerDrafts([{ kind: 'event', eventId, match: { somethingNewer: 'x' } }])
    ).toEqual([]);
  });
});
