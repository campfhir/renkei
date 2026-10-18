/**
 * The markdown round trip, proven end to end: export → extract → the
 * exact definition back — plus the extraction edge cases (no block, bad
 * JSON, quoted earlier blocks).
 */

import type { TriggerDraft } from '@renkei/agents';
import { agentMarkdown, type AgentExportInput } from './export-markdown';
import { extractAgentDefinition } from './import-markdown';
import { parseAgentPayload } from './payload';

const instructions = '## Goal\n\nFind the statement.\n\n```\nfenced example inside\n```';

const trigger: TriggerDraft = { kind: 'schedule', recurrences: [{ every: 'hour' }], timezone: '' };

const agent: AgentExportInput = {
  name: 'Statement finder',
  description: 'Finds statements.',
  enabled: true,
  instructions,
  tools: ['jira_search_issues', 'jira_add_comment'],
  triggers: [{ draft: trigger, enabled: true }],
  guardrails: 'Never invent numbers.',
  canAskQuestions: true,
  autoAcceptActions: true,
  limits: { minutes: 30, toolCalls: 150 },
};

describe('markdown round trip', () => {
  it('export → extract returns the exact definition, save-path parseable', () => {
    const extracted = extractAgentDefinition(agentMarkdown(agent));
    if (!extracted.ok) throw new Error(extracted.error);
    // The prose above the block does not matter — the block is the
    // source, byte-equal on every field the save path reads (instructions
    // with a fenced example inside them included).
    expect(extracted.definition.instructions).toBe(instructions);
    expect(extracted.definition.tools).toEqual(['jira_search_issues', 'jira_add_comment']);
    expect(extracted.definition.triggers).toEqual([{ draft: trigger, enabled: true }]);
    expect(extracted.definition.guardrails).toBe('Never invent numbers.');
    expect(extracted.definition.canAskQuestions).toBe(true);
    expect(extracted.definition.autoAcceptActions).toBe(true);

    const parsed = parseAgentPayload({ ...extracted.definition, enabled: false });
    expect('error' in parsed).toBe(false);
  });

  it('takes the LAST fenced block, so quoted examples cannot hijack it', () => {
    const decoy = '```json renkei-agent\n{"name":"decoy","instructions":"x","tools":[]}\n```';
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
