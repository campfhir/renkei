/**
 * One agent as a markdown document whose prompt section is the EXACT
 * system prompt the engine sends the model at run time — rendered through
 * @renkei/agents/run-prompts, the same code the engine calls, so this
 * cannot drift into a paraphrase.
 *
 * 1:1 has one honest boundary: runtime data. The run's opening message
 * (what triggered it), memory and knowledge notes exist only mid-run and
 * are omitted exactly as the engine omits them when absent; the limits
 * are the org's as of the export; tool SCHEMAS ride beside the messages
 * at run time and are listed here by name.
 */

import type { TriggerDraft } from '@renkei/agents';
import { runSystemPrompt } from '@renkei/agents/run-prompts';
import { fencedDefinition } from '@/lib/agents/definition';
import { triggerSummary } from '@/lib/agents/trigger-summary';

export interface AgentExportInput {
  name: string;
  description: string | null;
  enabled: boolean;
  instructions: string;
  tools: string[];
  triggers: { draft: TriggerDraft; enabled: boolean }[];
  guardrails: string | null;
  canAskQuestions: boolean;
  autoAcceptActions: boolean;
  /** The org's limits, as the run's frame states them. */
  limits: { minutes: number; toolCalls: number };
}

export function agentMarkdown(agent: AgentExportInput): string {
  return [
    `# ${agent.name}`,
    '',
    ...(agent.description ? [agent.description, ''] : []),
    `- Status: ${agent.enabled ? 'on' : 'off'}`,
    `- Limits per run: ${agent.limits.toolCalls} tool calls, ${agent.limits.minutes} minutes of active time`,
    `- Staged actions: ${agent.autoAcceptActions ? 'accepted automatically where the organization allows it' : 'accepted by the owner'}`,
    `- Can ask the owner questions: ${agent.canAskQuestions ? 'yes' : 'no'}`,
    '',
    'The system prompt below is rendered by the same code the engine runs, word for word.',
    'Runtime-only content is left out: what triggered the run arrives as the first message;',
    'memory and knowledge notes follow the instructions at run time; tool schemas ride beside',
    'the messages and are listed by name. The final "Definition" section is the exact stored',
    'definition — the round-trip half of this document.',
    '',
    '## Triggers',
    '',
    ...(agent.triggers.length > 0
      ? agent.triggers.map(
          (trigger) => `- ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
        )
      : ['- none (runs only when started by hand)']),
    '',
    '## Tools',
    '',
    ...(agent.tools.length > 0 ? agent.tools.map((tool) => `- ${tool}`) : ['- none']),
    '',
    '## System prompt',
    '',
    // Four backticks: the instructions inside may carry fenced blocks of
    // their own.
    '````',
    runSystemPrompt(
      agent.limits,
      { canAsk: agent.canAskQuestions },
      {
        agentName: agent.name,
        instructions: agent.instructions,
        ...(agent.guardrails ? { guardrailsText: agent.guardrails } : {}),
      }
    ),
    '````',
    '',
    // The round-trip half: everything above is projection; this block is
    // the SOURCE, verbatim, so the document can be imported back — Import
    // on the agents page, or the JSON passed to agent_create.
    '## Definition (machine-readable)',
    '',
    'The fenced block below is the exact stored definition. Paste this whole document',
    'into Import on the agents page (or pass the JSON to agent_create) to recreate the agent.',
    '',
    fencedDefinition(agent),
    '',
  ].join('\n');
}
