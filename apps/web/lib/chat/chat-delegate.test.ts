/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * An ordinary chat's sub-agent against a fake model and a fake MCP
 * surface: it reads through the chat's connector tools and its own
 * read-only local tools, keeps their results out of the report, finds
 * more connector reads through its own find_tools, and can never reach
 * a tool that acts — not one offered to the chat, not one it names from
 * memory. The delegation itself is read-only, so it never asks.
 */

import { ok } from '@campfhir/safe-functions/helpers';
import type { LlmProvider, LlmResponse, LlmToolDef, ResolvedLlm } from '@renkei/agent-llm';
import type { McpClient, McpToolResult } from '@renkei/mcp-client';
import type { SubagentRecorder } from './subagent-runs';
import { textResult, type LocalTool, type LocalToolContext } from './local-tools';
import {
  CHAT_DELEGATE_TOOL,
  CHAT_DELEGATE_TOOL_TIMEOUT_MS,
  CHAT_DELEGATE_WALL_CLOCK_MS,
  chatDelegateTool,
} from './chat-delegate';

function provider(replies: LlmResponse[]): {
  provider: LlmProvider;
  requests: LlmToolDef[][];
  /** The text of every tool result the sub-agent was handed, per request. */
  handed: string[][];
} {
  let index = 0;
  const requests: LlmToolDef[][] = [];
  const handed: string[][] = [];
  return {
    requests,
    handed,
    provider: {
      async complete(request) {
        requests.push(request.tools ?? []);
        const last = request.messages[request.messages.length - 1];
        handed.push(
          last?.role === 'user'
            ? last.content.flatMap((block) =>
                block.type === 'tool_result' && typeof block.content === 'string'
                  ? [block.content]
                  : []
              )
            : []
        );
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return ok(reply);
      },
    },
  };
}

const llmOf = (p: LlmProvider): ResolvedLlm => ({
  provider: p,
  modelConfigId: 'model-1',
  providerName: 'anthropic',
  model: 'claude-x',
  maxOutputTokens: 4096,
});

const done = (text: string): LlmResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 2 },
});

const calling = (uses: { id: string; name: string; input: Record<string, unknown> }[]) =>
  ({
    content: uses.map((use) => ({ type: 'tool_use' as const, ...use })),
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  }) satisfies LlmResponse;

const def = (name: string): LlmToolDef => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
});

/** The chat's connector surface: a Jira read and a Jira write up front, an Outlook read behind find_tools. */
function surface(mcp: McpClient | null) {
  return {
    tools: [def('jira_get_issue'), def('jira_create_issue'), def('jira_create_issue_preview')],
    discoverable: [
      { connector: 'microsoft', def: def('outlook_list_messages') },
      { connector: 'microsoft', def: def('outlook_send_mail') },
    ],
    readOnlyTools: new Set([
      'jira_get_issue',
      'jira_create_issue_preview',
      'outlook_list_messages',
    ]),
    mcp,
  };
}

function mcpClient(): { client: McpClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async initialize() {},
      async listTools() {
        return [];
      },
      async callTool(name, args): Promise<McpToolResult> {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return { content: [{ type: 'text', text: `result of ${name}` }], isError: false, meta: {} };
      },
    },
  };
}

const readAttachment: LocalTool = {
  def: def('chat_read_attachment'),
  readOnly: true,
  async execute(input) {
    return textResult(`attachment ${String(input.id)}`);
  },
};
const writeFile: LocalTool = {
  def: def('chat_write_file'),
  async execute() {
    return textResult('written');
  },
};

function context(extra: Partial<LocalToolContext>): LocalToolContext {
  return {
    db: null as unknown as LocalToolContext['db'],
    tenantId: 't',
    subject: 'u',
    chatId: 'c',
    projectId: null,
    readOnly: false,
    ...extra,
  };
}

describe('chat_delegate', () => {
  it('is read-only itself, with its own budget past the sub-agent wall clock', () => {
    const tool = chatDelegateTool({ surface: surface(null), localTools: [readAttachment] });
    expect(tool?.def.name).toBe(CHAT_DELEGATE_TOOL);
    expect(tool?.readOnly).toBe(true);
    expect(tool?.timeoutMs).toBe(CHAT_DELEGATE_TOOL_TIMEOUT_MS);
    expect(CHAT_DELEGATE_TOOL_TIMEOUT_MS).toBeGreaterThan(CHAT_DELEGATE_WALL_CLOCK_MS);
    // No readOnly argument: there is nothing else it could be.
    expect(Object.keys(tool?.def.inputSchema.properties ?? {})).toEqual([
      'task',
      'instructions',
      'maxSteps',
    ]);
  });

  it('is not offered at all when there is nothing to read with', () => {
    expect(
      chatDelegateTool({
        surface: { tools: [], discoverable: [], readOnlyTools: new Set(), mcp: null },
        localTools: [writeFile],
      })
    ).toBeNull();
  });

  it('reads through the connector and local tools, and only the report comes back', async () => {
    const { client, calls } = mcpClient();
    const fake = provider([
      calling([
        { id: 'u1', name: 'jira_get_issue', input: { key: 'OPS-41' } },
        { id: 'u2', name: 'chat_read_attachment', input: { id: 'a1' } },
      ]),
      done('OPS-41 is in progress; the attachment is the retro notes.'),
    ]);
    const recorded: string[] = [];
    const recorder: SubagentRecorder = {
      start: jest.fn(async (input) => {
        recorded.push(`start:${input.toolUseId}:${input.readOnly}:${input.maxSteps}`);
        return 'run-1';
      }),
      progress: jest.fn(async () => {}),
      finish: jest.fn(async (runId, outcome) => {
        recorded.push(`finish:${runId}:${outcome.status}:${outcome.steps}:${outcome.toolCalls}`);
      }),
    };
    const tool = chatDelegateTool({
      surface: surface(client),
      localTools: [readAttachment, writeFile],
    });
    const result = await tool!.execute(
      { task: 'What is OPS-41 about?' },
      context({ llm: llmOf(fake.provider), toolUseId: 'd1', subagents: recorder })
    );
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Sub-agent done — 2 model calls, 2 tool calls');
    expect(text).toContain('OPS-41 is in progress');
    expect(text).not.toContain('result of jira_get_issue');
    expect(text).not.toContain('attachment a1');
    expect(calls).toEqual(['jira_get_issue:{"key":"OPS-41"}']);
    // Offered: the connector reads, the local read, and find_tools for the rest — never a write.
    const offered = fake.requests[0]?.map((entry) => entry.name).sort();
    expect(offered).toEqual(['chat_read_attachment', 'find_tools', 'jira_get_issue']);
    // Recorded as a read-only run, with the default step budget.
    expect(recorded).toEqual(['start:d1:true:15', 'finish:run-1:completed:2:2']);
  });

  it('refuses a tool that acts, whether offered to the chat or named from memory', async () => {
    const { client, calls } = mcpClient();
    const fake = provider([
      calling([
        { id: 'u1', name: 'jira_create_issue', input: { summary: 'x' } },
        { id: 'u2', name: 'chat_write_file', input: { path: 'a.md' } },
        { id: 'u3', name: 'outlook_send_mail', input: { to: 'a@b' } },
      ]),
      done('I could not act, as expected.'),
    ]);
    const tool = chatDelegateTool({
      surface: surface(client),
      localTools: [readAttachment, writeFile],
    });
    const result = await tool!.execute(
      { task: 'File an issue' },
      context({ llm: llmOf(fake.provider), toolUseId: 'd1' })
    );
    expect(result.isError).toBe(false);
    expect(calls).toEqual([]);
    // Each refusal reached the sub-agent as an error result — and never the chat.
    expect(fake.handed[1]).toHaveLength(3);
    for (const handed of fake.handed[1] ?? []) {
      expect(handed).toContain('not available to a sub-agent');
    }
    expect(result.content[0]?.text).not.toContain('not available to a sub-agent');
  });

  it('finds more connector reads through its own find_tools, callable on the next call', async () => {
    const { client, calls } = mcpClient();
    const fake = provider([
      calling([{ id: 'u1', name: 'find_tools', input: { query: 'outlook' } }]),
      calling([{ id: 'u2', name: 'outlook_list_messages', input: { top: 5 } }]),
      done('Five messages, none about the sprint.'),
    ]);
    const tool = chatDelegateTool({ surface: surface(client), localTools: [] });
    const result = await tool!.execute(
      { task: 'Anything in mail about the sprint?' },
      context({ llm: llmOf(fake.provider), toolUseId: 'd1' })
    );
    expect(result.isError).toBe(false);
    expect(calls).toEqual(['outlook_list_messages:{"top":5}']);
    // Before the discovery the Outlook read was not offered; after it, it is — and the write never is.
    expect(fake.requests[0]?.map((entry) => entry.name)).not.toContain('outlook_list_messages');
    expect(fake.requests[1]?.map((entry) => entry.name)).toContain('outlook_list_messages');
    expect(fake.requests[1]?.map((entry) => entry.name)).not.toContain('outlook_send_mail');
  });

  it('refuses to run without a model, before spending anything', async () => {
    const fake = provider([done('never')]);
    const tool = chatDelegateTool({ surface: surface(null), localTools: [readAttachment] });
    const result = await tool!.execute({ task: 'x' }, context({}));
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});
