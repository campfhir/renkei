/**
 * The lint is the only thing telling an author that "comment on the
 * ticket" without a [the ticket] chip sends the step nothing — so what it
 * catches, what it leaves alone, and the fix it offers are pinned here.
 */

import { randomUUID } from 'node:crypto';
import { chipMention, lintAgentDraft } from './lint';
import type { ActionStep, AgentStepNode, InstructionSegment, LoopStep } from './steps';
import type { TriggerDraft } from './triggers';

const text = (v: string): InstructionSegment => ({ t: 'text', v });
const varChip = (name: string): InstructionSegment => ({ t: 'var', name });

function step(overrides: Partial<ActionStep> = {}): ActionStep {
  return {
    id: randomUUID(),
    name: 'A step',
    instruction: [text('Do the thing.')],
    tool: null,
    maxAttempts: 3,
    failureHandling: [],
    ...overrides,
  };
}

const webex: TriggerDraft = { kind: 'event', eventId: 'webex/message.received', match: {} };

function lint(steps: AgentStepNode[], triggers: TriggerDraft[] = []) {
  return lintAgentDraft({ steps: { version: 8, steps }, triggers });
}

describe('lintAgentDraft', () => {
  it('flags a saved result named in words without its chip, and offers the chip', () => {
    const finder = step({ name: 'Find the ticket', saveAs: 'the ticket' });
    const commenter = step({ instruction: [text('Comment on the ticket saying thanks.')] });
    const hints = lint([finder, commenter]);

    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      path: 'steps.1.instruction',
      variable: 'the ticket',
      at: { segment: 0, start: 11, end: 21 },
    });
    expect(hints[0]?.message).toContain('[the ticket]');
  });

  it('is quiet when the chip is there, in any order of mention', () => {
    const finder = step({ saveAs: 'the ticket' });
    const commenter = step({
      instruction: [text('Comment on the ticket: '), varChip('the ticket')],
    });
    expect(lint([finder, commenter])).toEqual([]);
  });

  it('does not flag a step for naming its own result, or a later step’s', () => {
    const finder = step({
      instruction: [text('Find the ticket for the request.')],
      saveAs: 'the ticket',
    });
    const earlier = step({ instruction: [text('Say hello to the ticket owner.')] });
    expect(lint([earlier, finder])).toEqual([]);
  });

  it('names trigger values by their key or spaced form, never by everyday words', () => {
    const roomy = step({ instruction: [text('Read the nearby messages and the sender.')] });
    const hints = lint([roomy], [{ kind: 'event', eventId: 'webex/message.received', match: {} }]);
    expect(hints.map((hint) => hint.variable)).toEqual(
      expect.arrayContaining(['trigger.nearbyMessages', 'trigger.sender'])
    );
    // "text" is four letters of ordinary English; only the dotted name counts.
    const plain = step({ instruction: [text('Write some text about it.')] });
    expect(lint([plain], [webex]).filter((hint) => hint.variable)).toEqual([]);
    const dotted = step({ instruction: [text('Use trigger.text as the subject.')] });
    expect(lint([dotted], [webex]).map((hint) => hint.variable)).toEqual(['trigger.text']);
  });

  it('points at an allusion to the triggering event when no trigger value is chipped', () => {
    const replier = step({ instruction: [text('Reply to the message with a thank-you.')] });
    const hints = lint([replier], [webex]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variable).toBeUndefined();
    expect(hints[0]?.message).toContain('[trigger.text]');
    expect(hints[0]?.at).toEqual({ segment: 0, start: 9, end: 20 });

    const chipped = step({
      instruction: [text('Reply to the message in '), varChip('trigger.roomId')],
    });
    expect(lint([chipped], [webex])).toEqual([]);
    // A bare noun without a determiner is not the trigger.
    const generic = step({ instruction: [text('Post a message to the team.')] });
    expect(lint([generic], [webex])).toEqual([]);
    // No event trigger, nothing to allude to.
    expect(lint([replier])).toEqual([]);
  });

  it('covers guidance and conditions, and skips a loop’s own item var', () => {
    const finder = step({ saveAs: 'the ticket' });
    const loop: LoopStep = {
      id: randomUUID(),
      kind: 'loop',
      name: 'Each comment',
      mode: 'foreach',
      itemsVar: 'the ticket',
      itemVar: 'comment',
      maxIterations: 5,
      steps: [
        step({
          instruction: [text('Summarize the comment against the ticket.')],
          failureHandling: [
            { outcome: 'other', action: 'retry', guidance: [text('Reread the ticket first.')] },
          ],
        }),
      ],
    };
    const branch: AgentStepNode = {
      id: randomUUID(),
      kind: 'branch',
      name: 'Relevant?',
      condition: [text('Is the ticket about billing?')],
      paths: [
        { id: randomUUID(), name: 'Yes', steps: [] },
        { id: randomUUID(), name: 'No', steps: [] },
      ],
      maxAttempts: 2,
    };
    const hints = lint([finder, loop, branch]);
    expect(hints.map((hint) => [hint.path, hint.variable])).toEqual([
      ['steps.1.steps.0.instruction', 'the ticket'],
      ['steps.1.steps.0.failureHandling.0', 'the ticket'],
      ['steps.2.condition', 'the ticket'],
    ]);
  });
});

describe('chipMention', () => {
  it('turns the mentioned words into the chip and keeps the surrounding text', () => {
    const segments = [text('Comment on the ticket saying thanks.')];
    expect(chipMention(segments, { segment: 0, start: 11, end: 21 }, 'the ticket')).toEqual([
      text('Comment on '),
      varChip('the ticket'),
      text(' saying thanks.'),
    ]);
  });

  it('leaves the list alone when the mention no longer fits', () => {
    const segments = [text('Short.')];
    expect(chipMention(segments, { segment: 0, start: 11, end: 21 }, 'the ticket')).toBe(segments);
    expect(chipMention(segments, { segment: 3, start: 0, end: 1 }, 'the ticket')).toBe(segments);
  });
});
