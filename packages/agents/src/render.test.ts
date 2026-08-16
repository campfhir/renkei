/**
 * Chips → prompt text. What matters: tool chips become the exact callable
 * name, var chips become their values, and an unbound var is LOUD — both
 * in the text and in the report — because silence there becomes a model
 * acting on an empty string.
 */

import { instructionPreview, renderInstruction } from './render';
import type { InstructionSegment } from './steps';

const segments: InstructionSegment[] = [
  { t: 'text', v: 'Look up the ticket in ' },
  { t: 'var', name: 'trigger.subject' },
  { t: 'text', v: ' using ' },
  { t: 'tool', name: 'jira_get_issue' },
];

describe('renderInstruction', () => {
  it('substitutes vars and names tools canonically', () => {
    const { text, unbound } = renderInstruction(segments, {
      'trigger.subject': 'PROJ-42 is broken',
    });
    expect(text).toBe('Look up the ticket in PROJ-42 is broken using jira_get_issue');
    expect(unbound).toEqual([]);
  });

  it('marks and reports unbound vars instead of rendering nothing', () => {
    const { text, unbound } = renderInstruction(segments, {});
    expect(text).toContain('(unknown: trigger.subject)');
    expect(unbound).toEqual(['trigger.subject']);
  });
});

describe('instructionPreview', () => {
  it('brackets chips so history reads at a glance', () => {
    expect(instructionPreview(segments)).toBe(
      'Look up the ticket in [trigger.subject] using [jira_get_issue]'
    );
  });
});
