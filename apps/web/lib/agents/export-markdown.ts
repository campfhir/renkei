/**
 * One agent as a markdown document — the whole definition in prose.
 *
 * The overview page's "Copy as Markdown" button serves this. It exists for
 * exactly the moments the builder cannot help: an agent saved in an older
 * steps format (loadable, not runnable) whose owner wants its content out
 * to rebuild or re-draft it, or anyone wanting the definition in a doc, a
 * ticket, or a model's context. Works for ANY loadable version because it
 * renders through the same permissive readers the page itself uses.
 */

import type { AgentStepsDoc, TriggerDraft } from '@renkei/agents';
import { CURRENT_STEPS_VERSION } from '@renkei/agents';
import { renderStepsOutline } from '@/lib/agents/describe';
import { triggerSummary } from '@/lib/agents/trigger-summary';

export interface AgentExportInput {
  name: string;
  description: string | null;
  enabled: boolean;
  steps: AgentStepsDoc;
  triggers: { draft: TriggerDraft; enabled: boolean }[];
  guardrails: string | null;
  blockedTools: string[];
}

export function agentMarkdown(agent: AgentExportInput): string {
  const stale = agent.steps.version < CURRENT_STEPS_VERSION;
  const lines: string[] = [
    `# ${agent.name}`,
    '',
    ...(agent.description ? [agent.description, ''] : []),
    `- Status: ${agent.enabled ? 'on' : 'off'}`,
    `- Steps format: version ${agent.steps.version}` +
      (stale ? ` (older than the current ${CURRENT_STEPS_VERSION} — re-save in the builder to update)` : ''),
    '',
    '## Triggers',
    '',
    ...(agent.triggers.length > 0
      ? agent.triggers.map(
          (trigger) => `- ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
        )
      : ['- none (runs only when started by hand)']),
    '',
  ];
  if (agent.guardrails) {
    lines.push('## Guardrails', '', agent.guardrails, '');
  }
  if (agent.blockedTools.length > 0) {
    lines.push('## Blocked skills', '', ...agent.blockedTools.map((tool) => `- ${tool}`), '');
  }
  // The outline is indented plain text, not markdown — fenced so its
  // structure survives every renderer.
  lines.push('## Steps', '', '```', renderStepsOutline(agent.steps).trimEnd() || '(no steps)', '```', '');
  return lines.join('\n');
}
