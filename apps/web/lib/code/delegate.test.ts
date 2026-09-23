/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * The delegate loop against a fake model: it runs the sub-agent's tool
 * calls itself, keeps them out of the answer (only the report comes
 * back), and records the run — start, progress per model call, and the
 * whole transcript at the end — when the turn hands it a recorder.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { LlmProvider, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import type { LlmCallModel } from '@renkei/agents/runs';
import { textResult, type LocalTool, type LocalToolContext } from '@/lib/chat/local-tools';
import type { SubagentRecorder } from '@/lib/chat/subagent-runs';
import {
  DELEGATE_TOOL_TIMEOUT_MS,
  DELEGATE_WALL_CLOCK_MS,
  codeDelegateTool,
  matchSubagentModel,
  type SubagentModelChoice,
} from './delegate';

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

const llmOf = (p: LlmProvider, modelConfigId = 'model-1', model = 'claude-x'): ResolvedLlm => ({
  provider: p,
  modelConfigId,
  providerName: 'anthropic',
  model,
  maxOutputTokens: 4096,
});

const done = (text: string): LlmResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 2 },
});

const ROSTER: SubagentModelChoice[] = [
  { id: 'model-1', label: 'Best', provider: 'anthropic', model: 'claude-x', isDefault: true },
  { id: 'model-2', label: 'Fast', provider: 'anthropic', model: 'claude-fast', isDefault: false },
];

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
        calls.push(
          `start:${input.toolUseId}:${input.readOnly}:${input.maxSteps}:${input.model?.model}`
        );
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
      // The run records the model it ran on — the turn's own, nothing picked.
      'start:d1:true:5:claude-x',
      'progress:run-1:1:1:code_read_file',
      'progress:run-1:2:1:null',
      // user task, assistant, results, assistant
      'finish:run-1:completed:2:4',
    ]);
  });

  it('runs on the model the orchestrator picks, and records it on the run and in the ledger', async () => {
    const turnProvider = provider([done('from the turn model')]);
    const fastProvider = provider([done('from the fast model')]);
    const resolve = jest.fn(async () => ok(llmOf(fastProvider, 'model-2', 'claude-fast')));
    const recorded: (LlmCallModel | null | undefined)[] = [];
    const started: (LlmCallModel | null)[] = [];
    const recorder: SubagentRecorder = {
      start: jest.fn(async (input) => {
        started.push(input.model);
        return 'run-1';
      }),
      progress: jest.fn(async () => {}),
      finish: jest.fn(async () => {}),
    };
    const tool = codeDelegateTool([readTool], { models: ROSTER, resolve });
    const result = await tool.execute(
      { task: 'Find every caller of foo', model: 'fast' },
      context({
        llm: llmOf(turnProvider),
        toolUseId: 'd2',
        subagents: recorder,
        recordUsage: async (_usage, model) => {
          recorded.push(model);
        },
      })
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('from the fast model');
    // Resolved by the chosen config's id, with its own key and settings.
    expect(resolve).toHaveBeenCalledWith(null, 't', 'model-2');
    const fast = { provider: 'anthropic', model: 'claude-fast', llmModelId: 'model-2' };
    expect(started).toEqual([fast]);
    expect(recorded).toEqual([fast]);
  });

  it('uses the turn model without resolving again when that is what was picked', async () => {
    const turnProvider = provider([done('same model')]);
    const resolve = jest.fn();
    const tool = codeDelegateTool([], { models: ROSTER, resolve });
    const result = await tool.execute(
      { task: 'do it', model: 'Best' },
      context({ llm: llmOf(turnProvider) })
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('same model');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a model that is not offered, naming the roster, before spending anything', async () => {
    const turnProvider = jest.fn();
    const tool = codeDelegateTool([], { models: ROSTER });
    const result = await tool.execute(
      { task: 'do it', model: 'gpt-imaginary' },
      context({ llm: llmOf({ complete: turnProvider }) })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No model called "gpt-imaginary"');
    expect(result.content[0]?.text).toContain('"Best", "Fast"');
    expect(turnProvider).not.toHaveBeenCalled();
  });

  it('refuses a pick that no longer resolves rather than quietly running on the default', async () => {
    // resolveAgentLlm falls back to the org default for a config that is
    // gone or disabled; the orchestrator asked for something else.
    const fallback = provider([done('default answered')]);
    const resolve = jest.fn(async () => ok(llmOf(fallback, 'model-1')));
    const tool = codeDelegateTool([], { models: ROSTER, resolve });
    const result = await tool.execute(
      { task: 'do it', model: 'Fast' },
      context({ llm: llmOf(provider([done('turn answered')])) })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"Fast" cannot be used right now');

    const broken = jest.fn(async () => err('CONFIG_ERROR' as const, { message: 'no key' }));
    const failing = codeDelegateTool([], { models: ROSTER, resolve: broken });
    const outcome = await failing.execute(
      { task: 'do it', model: 'Fast' },
      context({ llm: llmOf(provider([done('turn answered')])) })
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toContain('its configuration is incomplete');
  });

  it('offers the model argument and the roster only when there is a roster', () => {
    const bare = codeDelegateTool([]);
    expect(bare.def.inputSchema.properties).not.toHaveProperty('model');
    expect(bare.def.description).not.toContain('Available:');
    const offered = codeDelegateTool([], { models: ROSTER });
    expect(offered.def.inputSchema.properties).toHaveProperty('model');
    expect(offered.def.description).toContain('"Best" (anthropic claude-x, the org default)');
    expect(offered.def.description).toContain('"Fast" (anthropic claude-fast)');
  });

  it('matches a pick by id, label or model name, never loosely', () => {
    expect(matchSubagentModel(ROSTER, 'model-2')?.label).toBe('Fast');
    expect(matchSubagentModel(ROSTER, 'FAST')?.id).toBe('model-2');
    expect(matchSubagentModel(ROSTER, 'claude-fast')?.id).toBe('model-2');
    expect(matchSubagentModel(ROSTER, 'fas')).toBeNull();
    expect(matchSubagentModel(ROSTER, '')).toBeNull();
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
