/**
 * The export's contract: its step sections are byte-identical to what the
 * engine sends the model — proven by rendering the same step through the
 * shared builder and comparing against the fenced block, not by matching
 * hand-copied phrases.
 */

import { randomUUID } from 'node:crypto';
import type { ActionStep, AgentStepsDoc } from '@renkei/agents';
import {
  NORMAL_TOOL_CAP,
  SYSTEM_PROMPT,
  buildAttemptMessages,
  outcomeGuideFor,
} from '@renkei/agents/step-prompts';
import { agentMarkdown } from './export-markdown';

const step: ActionStep = {
  id: randomUUID(),
  name: 'Find the statement',
  instruction: [
    { t: 'text', v: 'Find the statement for ' },
    { t: 'var', name: 'trigger.month' },
    { t: 'text', v: ' with ' },
    { t: 'tool', name: 'jira_search_issues' },
  ],
  tool: 'jira_search_issues',
  maxAttempts: 3,
  saveAs: 'the statement',
  failureHandling: [
    {
      outcome: 'no-results',
      action: 'retry',
      guidance: [{ t: 'text', v: 'Broaden the search terms.' }],
      exhausted: 'continue',
    },
    {
      outcome: 'poor-match',
      action: 'continue',
      when: 'results exist but none match the description closely enough',
      guidance: [{ t: 'text', v: 'Note the closest candidates and move on.' }],
    },
  ],
};

const doc: AgentStepsDoc = { version: 8, steps: [step] };

function exported(guardrails: string | null = 'Never invent numbers.'): string {
  return agentMarkdown({
    name: 'Statement finder',
    description: 'Finds statements.',
    enabled: true,
    steps: doc,
    triggers: [],
    guardrails,
    blockedTools: [],
  });
}

describe('agentMarkdown', () => {
  it('embeds the step prompt byte-identical to the engine builder output', () => {
    const vars = { 'trigger.month': '{{trigger.month}}' };
    const guide = outcomeGuideFor(step, vars);
    const runtime = buildAttemptMessages({
      step,
      attempt: 1,
      variables: vars,
      toolBudget: NORMAL_TOOL_CAP,
      guardrailsText: 'Never invent numbers.',
      ...(guide ? { outcomeGuide: guide } : {}),
    }).messages[0].content[0];
    if (runtime?.type !== 'text') throw new Error('expected a text block');

    expect(exported()).toContain('```\n' + runtime.text + '\n```');
  });

  it('carries the runtime rules the reader needs to trust it', () => {
    const markdown = exported();
    // The step system prompt, verbatim, with the guardrails framing.
    expect(markdown).toContain(SYSTEM_PROMPT);
    expect(markdown).toContain('guardrails are shown with the step');
    // The guardrails block inside the step message, exactly as injected.
    expect(markdown).toContain('Standing guardrails from this agent’s owner');
    // The custom condition steers via its applies-when text…
    expect(markdown).toContain(
      '"poor-match" (applies when: results exist but none match the description closely enough)'
    );
    // …with the author's non-retry note, and WITHOUT attempt-1 retry text.
    expect(markdown).toContain('the author notes: Note the closest candidates and move on.');
    expect(markdown).not.toContain('Broaden the search terms.');
    // Variables are placeholders, stated up front.
    expect(markdown).toContain('{{trigger.month}}');
    expect(markdown).toContain(`Tool budget: at most ${NORMAL_TOOL_CAP} tool call(s)`);
  });

  it('drops the guardrails framing when the agent has none', () => {
    const markdown = exported(null);
    expect(markdown).toContain(SYSTEM_PROMPT);
    expect(markdown).not.toContain('Standing guardrails');
  });
});
