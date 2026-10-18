import {
  mergeOpenedDetail,
  outlineToolCalls,
  sealedDetailOf,
  splitDetailForSealing,
} from './turn-detail';

const detail = {
  opening: 'Started by hand… PROJ-42 is broken',
  assistant: [
    { type: 'tool_use', id: 't1', name: 'jira_get_issue', input: { issueKey: 'PROJ-42' } },
  ],
  results: [{ type: 'tool_result', toolUseId: 't1', content: 'patient Jane Doe cannot sign in' }],
  llmSummary: 'Found PROJ-42.',
  result: 'PROJ-42',
  finish: 'done',
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
      tool: 'finish_run',
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
      finish: 'done',
      modelCalls: [{ durationMs: 900, stopReason: 'tool_use' }],
      usage: { inputTokens: 10, outputTokens: 4 },
      toolCalls: [
        { tool: 'jira_get_issue', durationMs: 120, resultChars: 41 },
        { tool: 'finish_run', free: true, durationMs: 1, resultChars: 0 },
      ],
    });
    const clearText = JSON.stringify(clear);
    for (const secret of ['PROJ-42', 'Jane Doe', 'Started by hand', 'Found']) {
      expect(clearText).not.toContain(secret);
    }
    expect(plaintext).not.toBeNull();
    expect(JSON.parse(plaintext!)).toEqual({
      opening: detail.opening,
      assistant: detail.assistant,
      results: detail.results,
      llmSummary: detail.llmSummary,
      result: 'PROJ-42',
      toolCalls: detail.toolCalls,
    });
  });

  it('has nothing to seal for a detail with no content field', () => {
    expect(splitDetailForSealing({ finish: 'nothing_to_do', usage: {} })).toEqual({
      clear: { finish: 'nothing_to_do', usage: {} },
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
      finish: 'done',
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
    const pause = { pause: { kind: 'question', cardId: 'c1' } };
    expect(mergeOpenedDetail(pause, null, 'm')).toBe(pause);
    expect(mergeOpenedDetail(null, null, 'm')).toBeNull();
    expect(sealedDetailOf(pause)).toBeNull();
  });
});
