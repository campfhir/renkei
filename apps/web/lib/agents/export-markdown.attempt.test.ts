/**
 * The export promises "variables appear as {{name}} placeholders". The
 * attempt chips must keep that promise: an exported agent is read by a
 * person, and "try 1 of 3" would read as the instruction's literal text.
 */
import { buildAttemptMessages } from '@renkei/agents/step-prompts';
import type { ActionStep } from '@renkei/agents';

const step: ActionStep = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check the schema',
  instruction: [
    { t: 'text', v: 'Try ' },
    { t: 'var', name: 'attempt' },
    { t: 'text', v: ' of ' },
    { t: 'var', name: 'attempt.max' },
    { t: 'text', v: '.' },
  ],
  tool: null,
  maxAttempts: 3,
  failureHandling: [],
};

it('keeps caller-supplied placeholders for the attempt chips', () => {
  const built = buildAttemptMessages({
    step,
    attempt: 1,
    // What export-markdown passes: every var chip bound to its placeholder.
    variables: { attempt: '{{attempt}}', 'attempt.max': '{{attempt.max}}' },
    toolBudget: 5,
  });

  expect(built.messages[0].content[0].text).toContain(
    'Instruction: Try {{attempt}} of {{attempt.max}}.'
  );
});
