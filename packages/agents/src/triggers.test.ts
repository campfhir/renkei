/**
 * triggerVariableDescriptors: every trigger kind contributes its variables
 * with descriptions, names dedupe across triggers, and triggerVariableNames
 * stays the descriptor list's name projection.
 */

import { triggerVariableDescriptors, triggerVariableNames, type TriggerDraft } from './triggers';
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
    expect(new Set(descriptors.map((descriptor) => descriptor.name)).size).toBe(
      descriptors.length
    );
    expect(triggerVariableNames(drafts)).toEqual(descriptors.map((descriptor) => descriptor.name));
  });
});
