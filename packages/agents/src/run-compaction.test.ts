import { foldBatches, foldRequestText, renderTurnForFold, summaryOpening } from './run-compaction';

describe('run compaction', () => {
  it('renders a turn as what was said, called and returned, clipped', () => {
    const text = renderTurnForFold({
      attempt: 3,
      opening: 'Resume: look in OPS instead.',
      assistant: [
        { type: 'text', text: 'Reading the ticket.' },
        { type: 'tool_use', id: 'a', name: 'jira_get_issue', input: { issueKey: 'OPS-7' } },
        { type: 'thinking' },
      ],
      results: [{ toolUseId: 'a', content: `OPS-7: VPN outage ${'x'.repeat(10_000)}` }],
    });
    expect(text).toContain('## Turn 3');
    expect(text).toContain('Note to the agent: Resume: look in OPS instead.');
    expect(text).toContain('Agent: Reading the ticket.');
    expect(text).toContain('Called jira_get_issue({"issueKey":"OPS-7"})');
    expect(text).toContain('Result: OPS-7: VPN outage');
    expect(text).toMatch(/\[\d+ more characters\]/);
    expect(text.length).toBeLessThan(5_000);
  });

  it('splits a long span into batches and asks for the notes merged', () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      attempt: index + 1,
      assistant: [{ type: 'text', text: 'y'.repeat(3_000) }],
    }));
    const batches = foldBatches(turns, 7_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.join('\n')).toContain('## Turn 6');
    expect(foldRequestText(null, 'T')).toContain('There are no notes yet.');
    expect(foldRequestText('old notes', 'T')).toContain('The notes so far:\n\nold notes');
    expect(summaryOpening('N', 4)).toContain('turns 1–4');
  });
});
