/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * The delegate loop against a fake model: it runs the sub-agent's tool
 * calls itself, keeps them out of the answer (only the report comes
 * back), and records the run — start, progress per model call, and the
 * whole transcript at the end — when the turn hands it a recorder.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { LlmProvider, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import { textResult, type LocalTool, type LocalToolContext } from '@/lib/chat/local-tools';
import type { SubagentRecorder } from '@/lib/chat/subagent-runs';
import { DELEGATE_TOOL_TIMEOUT_MS, DELEGATE_WALL_CLOCK_MS, codeDelegateTool } from './delegate';

function provider(replies: LlmResponse[]): LlmProvider {
  let index = 0;
  return {
    async complete() {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return ok(reply);
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

const readTool: LocalTool = {
  def: { name: 'code_read_file', description: 'read', inputSchema: { type: 'object' } },
  readOnly: true,
  async execute(input) {
    return textResult(`contents of ${String(input.path)}`);
  },
};
const pushTool: LocalTool = {
  def: { name: 'code_git_push', description: 'push', inputSchema: { type: 'object' } },
  async execute() {
    return textResult('pushed');
  },
};

function context(extra: Partial<LocalToolContext>): LocalToolContext {
  return {
    db: null as unknown as LocalToolContext['db'],
    tenantId: 't',
    subject: 'u',
    chatId: 'c',
    projectId: 'p',
    readOnly: false,
    ...extra,
  };
}

describe('code_delegate', () => {
  it('runs the sub-agent to its report and records the run around it', async () => {
    const llm = llmOf(
      provider([
        {
          content: [
            { type: 'text', text: 'Reading first.' },
            { type: 'tool_use', id: 'u1', name: 'code_read_file', input: { path: 'a.ts' } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        {
          content: [{ type: 'text', text: 'a.ts exports one function; nothing to change.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 6 },
        },
      ])
    );
    const calls: string[] = [];
    const recorder: SubagentRecorder = {
      start: jest.fn(async (input) => {
        calls.push(`start:${input.toolUseId}:${input.readOnly}:${input.maxSteps}`);
        return 'run-1';
      }),
      progress: jest.fn(async (runId, state) => {
        calls.push(`progress:${runId}:${state.steps}:${state.toolCalls}:${state.lastTool}`);
      }),
      finish: jest.fn(async (runId, outcome) => {
        calls.push(
          `finish:${runId}:${outcome.status}:${outcome.steps}:${outcome.transcript.length}`
        );
      }),
    };
    const tool = codeDelegateTool([readTool, pushTool]);
    const result = await tool.execute(
      { task: 'Look at a.ts', readOnly: true, maxSteps: 5 },
      context({ llm, toolUseId: 'd1', subagents: recorder })
    );
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Sub-agent done — 2 model calls, 1 tool call (code_read_file×1)');
    expect(text).toContain('a.ts exports one function');
    // The sub-agent's own reads never appear in what the chat receives.
    expect(text).not.toContain('contents of a.ts');
    expect(calls).toEqual([
      'start:d1:true:5',
      'progress:run-1:1:1:code_read_file',
      'progress:run-1:2:1:null',
      // user task, assistant, results, assistant
      'finish:run-1:completed:2:4',
    ]);
  });

  it('declares its own timeout, well past the sub-agent wall clock', () => {
    // The orchestrator races this whole call against a per-tool timeout
    // (turn-runner.ts); code_delegate's own loop can legitimately run for
    // DELEGATE_WALL_CLOCK_MS, so the race must not fire before then.
    const tool = codeDelegateTool([]);
    expect(tool.timeoutMs).toBeGreaterThan(DELEGATE_WALL_CLOCK_MS);
    expect(tool.timeoutMs).toBe(DELEGATE_TOOL_TIMEOUT_MS);
  });

  it('retries a transient model-call error rather than failing the run', async () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const flaky: LlmProvider = {
        async complete() {
          attempts += 1;
          if (attempts === 1) return err('network' as const, { message: 'boom' });
          return ok({
            content: [{ type: 'text', text: 'All good in the end.' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      };
      const tool = codeDelegateTool([]);
      const promise = tool.execute({ task: 'do it' }, context({ llm: llmOf(flaky) }));
      // Let the retry's backoff delay elapse without waiting on real time.
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(attempts).toBe(2);
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain('All good in the end.');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry an error that describes the request, not the moment', async () => {
    let attempts = 0;
    const badKey: LlmProvider = {
      async complete() {
        attempts += 1;
        return err('auth' as const, { message: 'bad key' });
      },
    };
    const tool = codeDelegateTool([]);
    const result = await tool.execute({ task: 'do it' }, context({ llm: llmOf(badKey) }));
    expect(attempts).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/rejected/);
  });

  it('runs without a recorder, and withholds pushing from the sub-agent', async () => {
    const llm = llmOf(
      provider([
        {
          content: [{ type: 'tool_use', id: 'u1', name: 'code_git_push', input: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          content: [{ type: 'text', text: 'Could not push.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ])
    );
    const tool = codeDelegateTool([readTool, pushTool]);
    const result = await tool.execute({ task: 'push it' }, context({ llm, toolUseId: 'd2' }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('Could not push.');
  });
});
