/**
 * The markdown round trip, proven end to end: export → extract → the
 * exact definition back — plus the extraction edge cases (no block, bad
 * JSON, quoted earlier blocks).
 */

import { randomUUID } from 'node:crypto';
import type { AgentStepsDoc, TriggerDraft } from '@renkei/agents';
import { agentMarkdown, type AgentExportInput } from './export-markdown';
import { extractAgentDefinition } from './import-markdown';
import { parseAgentPayload } from './payload';

const doc: AgentStepsDoc = {
  version: 8,
  steps: [
    {
      id: randomUUID(),
      name: 'Find the statement',
      instruction: [
        { t: 'text', v: 'Find it with ' },
        { t: 'tool', name: 'jira_search_issues' },
      ],
      tool: 'jira_search_issues',
      maxAttempts: 3,
      saveAs: 'the statement',
      failureHandling: [
        {
          outcome: 'poor-match',
          action: 'continue',
          when: 'results exist but none match closely',
          guidance: [{ t: 'text', v: 'Note the closest candidates.' }],
        },
      ],
      onSuccess: 'stop-quiet',
    },
  ],
};

const trigger: TriggerDraft = { kind: 'schedule', recurrences: [{ every: 'hour' }], timezone: '' };

const agent: AgentExportInput = {
  name: 'Statement finder',
  description: 'Finds statements.',
  enabled: true,
  steps: doc,
  triggers: [{ draft: trigger, enabled: true }],
  guardrails: 'Never invent numbers.',
  blockedTools: ['outlook_send_mail'],
};

describe('markdown round trip', () => {
  it('export → extract returns the exact definition, save-path parseable', () => {
    const extracted = extractAgentDefinition(agentMarkdown(agent));
    if (!extracted.ok) throw new Error(extracted.error);
    // The lossy prose above the block does not matter — the block is the
    // source, byte-equal on every field the save path reads. onSuccess and
    // the custom `when` survive, which no prose parse could promise.
    expect(extracted.definition.steps).toEqual(doc);
    expect(extracted.definition.triggers).toEqual([{ draft: trigger, enabled: true }]);
    expect(extracted.definition.guardrails).toBe('Never invent numbers.');
    expect(extracted.definition.blockedTools).toEqual(['outlook_send_mail']);

    const parsed = parseAgentPayload({
      name: String(extracted.definition.name),
      steps: extracted.definition.steps,
      triggers: extracted.definition.triggers,
      enabled: false,
      llmModelId: null,
      guardrails: extracted.definition.guardrails,
      blockedTools: extracted.definition.blockedTools,
    });
    expect('error' in parsed).toBe(false);
  });

  it('takes the LAST fenced block, so quoted examples cannot hijack it', () => {
    const decoy = '```json renkei-agent\n{"name":"decoy","steps":{"version":8,"steps":[]}}\n```';
    const markdown = `Some prose quoting an export:\n\n${decoy}\n\n${agentMarkdown(agent)}`;
    const extracted = extractAgentDefinition(markdown);
    if (!extracted.ok) throw new Error(extracted.error);
    expect(extracted.definition.name).toBe('Statement finder');
  });

  it('says plainly when there is no block or the JSON is broken', () => {
    const none = extractAgentDefinition('# Just prose');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('No definition block');

    const broken = extractAgentDefinition('```json renkei-agent\n{oops\n```');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain('not valid JSON');
  });
});
