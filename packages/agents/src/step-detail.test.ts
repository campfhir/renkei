import {
  mergeOpenedDetail,
  outlineToolCalls,
  sealedDetailOf,
  splitDetailForSealing,
} from './step-detail';

const detail = {
  resolvedInstruction: 'Find the ticket mentioned in PROJ-42 is broken',
  promptText: 'You are executing one step… PROJ-42 is broken',
  llmSummary: 'Found PROJ-42.',
  declaredOutcome: 'success',
  saveValue: 'PROJ-42',
  saveItems: ['PROJ-42', 'PROJ-43'],
  unboundVariables: ['missing'],
  toolCalls: [
    {
      tool: 'jira_get_issue',
      argsPreview: '{"issueKey":"PROJ-42"}',
      resultPreview: 'Summary: patient Jane Doe cannot sign in',
      resultChars: 41,
      isError: false,
      durationMs: 120,
    },
    {
      tool: 'finish_step',
      free: true,
      argsPreview: '{}',
      resultPreview: '',
      resultChars: 0,
      durationMs: 1,
    },
  ],
  modelCalls: [{ durationMs: 900, stopReason: 'tool_use' }],
  usage: { inputTokens: 10, outputTokens: 4 },
};

describe('splitDetailForSealing', () => {
  it('keeps structure in the clear and every content field in the plaintext to seal', () => {
    const { clear, plaintext } = splitDetailForSealing(detail);
    expect(clear).toEqual({
      declaredOutcome: 'success',
      unboundVariables: ['missing'],
      modelCalls: [{ durationMs: 900, stopReason: 'tool_use' }],
      usage: { inputTokens: 10, outputTokens: 4 },
      toolCalls: [
        { tool: 'jira_get_issue', durationMs: 120, resultChars: 41 },
        { tool: 'finish_step', free: true, durationMs: 1, resultChars: 0 },
      ],
    });
    const clearText = JSON.stringify(clear);
    for (const secret of ['PROJ-42', 'Jane Doe', 'executing one step', 'Found']) {
      expect(clearText).not.toContain(secret);
    }
    expect(plaintext).not.toBeNull();
    expect(JSON.parse(plaintext!)).toEqual({
      promptText: detail.promptText,
      resolvedInstruction: detail.resolvedInstruction,
      llmSummary: detail.llmSummary,
      saveValue: 'PROJ-42',
      saveItems: ['PROJ-42', 'PROJ-43'],
      toolCalls: detail.toolCalls,
    });
  });

  it('has nothing to seal for a detail with no content field', () => {
    expect(splitDetailForSealing({ declaredOutcome: 'skipped', usage: {} })).toEqual({
      clear: { declaredOutcome: 'skipped', usage: {} },
      plaintext: null,
    });
  });

  it('outlines tool calls defensively', () => {
    expect(outlineToolCalls('nope')).toEqual([]);
    expect(outlineToolCalls([null, { argsPreview: 'x' }, { tool: 'a', isError: true }])).toEqual([
      {},
      { tool: 'a', isError: true },
    ]);
  });
});

describe('mergeOpenedDetail', () => {
  const stored = { ...splitDetailForSealing(detail).clear, sealed: 'uenc1:…' };

  it('round-trips: the opened envelope restores the row as it was written', () => {
    const { plaintext } = splitDetailForSealing(detail);
    expect(mergeOpenedDetail(stored, plaintext, '[locked]')).toEqual(detail);
    expect(sealedDetailOf(stored)).toBe('uenc1:…');
  });

  it('renders the marker, and says so, when the envelope does not open', () => {
    const merged = mergeOpenedDetail(stored, null, '[content unavailable: key not connected]');
    expect(merged).toMatchObject({
      declaredOutcome: 'success',
      llmSummary: '[content unavailable: key not connected]',
      sealedUnavailable: true,
      toolCalls: [{ tool: 'jira_get_issue', durationMs: 120, resultChars: 41 }, expect.anything()],
    });
    expect(JSON.stringify(merged)).not.toContain('PROJ-42');
    expect(merged).not.toHaveProperty('sealed');
    // A corrupt envelope is the same story as a locked one.
    expect(mergeOpenedDetail(stored, '{not json', 'm')).toMatchObject({ llmSummary: 'm' });
  });

  it('passes a detail without an envelope through untouched (rows from before, pause rows)', () => {
    const pause = { pauseKind: 'question', message: 'Which one?' };
    expect(mergeOpenedDetail(pause, null, 'm')).toBe(pause);
    expect(mergeOpenedDetail(null, null, 'm')).toBeNull();
    expect(sealedDetailOf(pause)).toBeNull();
  });
});
