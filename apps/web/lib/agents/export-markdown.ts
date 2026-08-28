/**
 * One agent as a markdown document whose step sections are the EXACT
 * prompts the engine sends the model at run time — rendered through
 * @renkei/agents/step-prompts, the same code the engine calls, so this
 * cannot drift into a paraphrase.
 *
 * 1:1 has one honest boundary: runtime data. Variables render as
 * {{name}} placeholders where real values bind during a run; memory,
 * knowledge notes, and previous-attempt sections exist only mid-run and
 * are omitted (the builders omit them exactly the same way when absent);
 * date chips resolve against the clock at export time; tool SCHEMAS ride
 * beside the messages at run time and are listed here by name. Every word
 * of message text is the runtime text.
 *
 * Works for ANY loadable steps version because it renders through the
 * same permissive readers the page itself uses — which is the point: the
 * owner of a stale, disabled agent exports exactly what a current-format
 * save would run.
 */

import {
  CURRENT_STEPS_VERSION,
  varSegments,
  walkSteps,
  type ActionStep,
  type AgentStepsDoc,
  type InstructionSegment,
  type TriggerDraft,
} from '@renkei/agents';
import {
  BRANCH_SYSTEM_PROMPT,
  CHOOSE_PATH_TOOL,
  FINISH_STEP_TOOL,
  LOOP_DECISION_TOOL,
  LOOP_SYSTEM_PROMPT,
  NORMAL_TOOL_CAP,
  RESOLVE_TIME_TOOL,
  ROUTER_SYSTEM_PROMPT,
  buildAttemptMessages,
  buildBranchMessages,
  buildLoopConditionMessages,
  outcomeGuideFor,
  systemPromptWith,
} from '@renkei/agents/step-prompts';
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

/** Every var chip a node's prompt renders, bound to a {{name}} placeholder. */
function placeholderVars(lists: InstructionSegment[][]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const segments of lists) {
    for (const name of varSegments(segments)) vars[name] = `{{${name}}}`;
  }
  return vars;
}

function messageText(built: { messages: { content: { text: string }[] }[] }): string {
  return built.messages.map((message) => message.content[0]?.text ?? '').join('\n\n');
}

function actionPromptVars(step: ActionStep): Record<string, string> {
  return placeholderVars([
    step.instruction,
    // Non-retry prose renders into the outcome guide; retry guidance does
    // not appear on attempt 1 and is excluded exactly as at run time.
    ...step.failureHandling
      .filter((handling) => handling.action !== 'retry')
      .map((handling) => handling.guidance ?? []),
  ]);
}

export function agentMarkdown(agent: AgentExportInput): string {
  const stale = agent.steps.version < CURRENT_STEPS_VERSION;
  const guardrailsText = agent.guardrails ?? '';
  const lines: string[] = [
    `# ${agent.name}`,
    '',
    ...(agent.description ? [agent.description, ''] : []),
    `- Status: ${agent.enabled ? 'on' : 'off'}`,
    `- Steps format: version ${agent.steps.version}` +
      (stale
        ? ` (older than the current ${CURRENT_STEPS_VERSION} — re-save in the builder to update)`
        : ''),
    ...(agent.blockedTools.length > 0
      ? [`- Blocked skills (the engine refuses these): ${agent.blockedTools.join(', ')}`]
      : []),
    '',
    'The prompt sections below are rendered by the same code the engine runs, word for word.',
    'Runtime-only content is substituted honestly: variables appear as {{name}} placeholders',
    'where real values bind during a run; memory, knowledge notes, and retry context exist',
    'only mid-run and are omitted; tool schemas ride beside the messages and are listed by',
    'name.',
    '',
    '## Triggers',
    '',
    ...(agent.triggers.length > 0
      ? agent.triggers.map(
          (trigger) => `- ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
        )
      : ['- none (runs only when started by hand)']),
    '',
    '## System prompt (every action step)',
    '',
    '```',
    systemPromptWith(guardrailsText || undefined),
    '```',
    '',
  ];

  // The engine nudges a step toward saveItems when its saved result feeds a
  // foreach loop — computed here exactly as at run time.
  const loopSourceVars = new Set(
    walkSteps(agent.steps.steps).flatMap(({ node }) =>
      node.kind === 'loop' && node.mode === 'foreach' ? [node.itemsVar] : []
    )
  );

  for (const { node, ordinal } of walkSteps(agent.steps.steps)) {
    switch (node.kind) {
      case 'action':
      case undefined: {
        const vars = actionPromptVars(node);
        const built = buildAttemptMessages({
          step: node,
          attempt: 1,
          variables: vars,
          toolBudget: NORMAL_TOOL_CAP,
          ...(guardrailsText ? { guardrailsText } : {}),
          ...(node.saveAs && loopSourceVars.has(node.saveAs)
            ? { savesItemsForLoop: true }
            : {}),
          ...(() => {
            const guide = outcomeGuideFor(node, vars);
            return guide ? { outcomeGuide: guide } : {};
          })(),
        });
        const offered = [
          FINISH_STEP_TOOL,
          RESOLVE_TIME_TOOL,
          ...(node.tool ? [node.tool] : []),
        ].join(', ');
        lines.push(
          `## Step ${ordinal + 1}: ${node.name || '(unnamed)'}`,
          '',
          `Tools offered (schemas ride separately): ${offered}`,
          '',
          '```',
          messageText(built),
          '```',
          ''
        );
        break;
      }
      case 'branch': {
        const vars = placeholderVars([node.condition]);
        const built = buildBranchMessages({ branch: node, variables: vars, attempt: 1, ...(guardrailsText ? { guardrailsText } : {}) });
        const router = node.paths.length !== 2;
        lines.push(
          `## Step ${ordinal + 1}: Branch — ${node.name || '(unnamed)'}`,
          '',
          `System prompt (${router ? 'router' : 'two-path branch'}); tool offered: ${CHOOSE_PATH_TOOL}`,
          '',
          '```',
          router ? ROUTER_SYSTEM_PROMPT : BRANCH_SYSTEM_PROMPT,
          '```',
          '',
          '```',
          messageText(built),
          '```',
          ''
        );
        break;
      }
      case 'loop': {
        if (node.mode === 'until') {
          const vars = placeholderVars([node.condition]);
          const built = buildLoopConditionMessages({
            loop: node,
            iteration: 1,
            variables: vars,
            attempt: 1,
            ...(guardrailsText ? { guardrailsText } : {}),
          });
          lines.push(
            `## Step ${ordinal + 1}: Loop — ${node.name || '(unnamed)'}`,
            '',
            `Checked after each round of its body; tool offered: ${LOOP_DECISION_TOOL}`,
            '',
            '```',
            LOOP_SYSTEM_PROMPT,
            '```',
            '',
            '```',
            messageText(built),
            '```',
            ''
          );
        } else {
          lines.push(
            `## Step ${ordinal + 1}: Loop — ${node.name || '(unnamed)'}`,
            '',
            `No prompt of its own: the engine iterates {{${node.itemsVar}}} deterministically, ` +
              `binding each item to {{${node.itemVar}}} for the body steps below (at most ${node.maxIterations} rounds).`,
            ''
          );
        }
        break;
      }
      case 'group':
        lines.push(
          `## Step ${ordinal + 1}: Group — ${node.name || '(unnamed)'}`,
          '',
          'No prompt of its own — groups only organize the steps below.',
          ''
        );
        break;
      case 'terminal':
        lines.push(
          `## Step ${ordinal + 1}: End — ${node.name || '(unnamed)'}`,
          '',
          `No prompt: reaching it ends the run as ${node.result} deterministically.`,
          ''
        );
        break;
      case 'approval':
        lines.push(
          `## Step ${ordinal + 1}: Approval — ${node.name || '(unnamed)'}`,
          '',
          'No model prompt: the run pauses for the OWNER (' +
            `${node.mode === 'input' ? 'typed answer' : 'approve/decline'}, up to ${node.timeoutHours}h).`,
          ''
        );
        break;
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return lines.join('\n');
}
