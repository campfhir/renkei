/* eslint-disable @typescript-eslint/consistent-type-assertions -- a bare context for a tool that never reads it */
import { parseTaskCompletion, taskCompleteTool, TASK_COMPLETE_TOOL } from './auto-mode';
import type { LocalToolContext } from './local-tools';

const context = { readOnly: false } as unknown as LocalToolContext;

describe('task_complete', () => {
  it('is read-only, so it never parks the turn behind a permission ask', () => {
    const tool = taskCompleteTool();
    expect(tool.def.name).toBe(TASK_COMPLETE_TOOL);
    expect(tool.readOnly).toBe(true);
  });

  it('acknowledges a done or needs_input outcome and refuses anything else', async () => {
    const tool = taskCompleteTool();
    const done = await tool.execute({ outcome: 'done', summary: 'Fixed it.' }, context);
    expect(done.isError).toBe(false);
    expect(done.content[0]?.text).toMatch(/marked complete/);
    const waiting = await tool.execute({ outcome: 'needs_input' }, context);
    expect(waiting.isError).toBe(false);
    expect(waiting.content[0]?.text).toMatch(/waiting on the person/);
    const bad = await tool.execute({ outcome: 'maybe' }, context);
    expect(bad.isError).toBe(true);
  });
});

describe('parseTaskCompletion', () => {
  it('reads the outcome and trims the summary', () => {
    expect(parseTaskCompletion({ outcome: 'done', summary: '  ok ' })).toEqual({
      outcome: 'done',
      summary: 'ok',
    });
    expect(parseTaskCompletion({ outcome: 'needs_input' })).toEqual({
      outcome: 'needs_input',
      summary: '',
    });
    expect(parseTaskCompletion({ outcome: 'later' })).toBeNull();
    expect(parseTaskCompletion('done')).toBeNull();
  });
});
