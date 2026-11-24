/**
 * `chat_ask_agent`: the chat hands one of the person's agents a task
 * (agent-asks.ts). It acts — it starts a run that spends the agent
 * owner's allowance and may act on their accounts within the agent's
 * approvals — so like any acting tool it asks the person first, unless
 * they addressed the message to that very agent themselves (@-mention in
 * the composer: start-turn.ts allows it for that turn), in which case
 * asking again would only repeat what they just said. A turn addressed to
 * one agent may not hand work to another without asking.
 */

import { CHAT_ASK_AGENT_TOOL } from './agent-ask-view';
import { askAgent, ASK_TASK_MAX_CHARS } from './agent-asks';
import { errorResult, textResult, type LocalTool } from './local-tools';

export function chatAskAgentTool(options: {
  chat: { id: string; title: string | null };
  /** The agent the person addressed this turn's message to, if they did. */
  addressedAgentId: string | null;
}): LocalTool {
  return {
    def: {
      name: CHAT_ASK_AGENT_TOOL,
      description:
        'Hand one of the person’s agents a task, as they would message a colleague who knows the area. ' +
        'The agent works in the background with its own tools and approvals and replies into this chat when done — do not wait for it. ' +
        'It sees nothing of this chat but `task`, so write the whole request: the goal, the specifics, and what a good answer contains.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The id of an agent listed in your instructions.',
          },
          task: {
            type: 'string',
            description: `What the agent should do, complete on its own (at most ${ASK_TASK_MAX_CHARS.toLocaleString()} characters).`,
          },
        },
        required: ['agent_id', 'task'],
      },
    },
    async execute(input, context) {
      const agentId = typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
      const task = typeof input.task === 'string' ? input.task : '';
      if (!context.toolUseId) return errorResult('This call cannot be tied to the chat.');
      if (options.addressedAgentId && agentId !== options.addressedAgentId) {
        return errorResult(
          'The person addressed this message to a different agent. Ask the agent they named, or ask them before handing the work to another one.'
        );
      }
      const outcome = await askAgent({
        subject: context.subject,
        chat: options.chat,
        toolUseId: context.toolUseId,
        agentId,
        message: task,
      });
      if (!outcome.ok) return errorResult(outcome.message);
      return textResult(
        `${outcome.agentName} has the task and is working on it in the background. Its reply will appear in this chat when it finishes — tell the person that in a sentence, and do not do the task yourself or guess its answer.`
      );
    },
  };
}
