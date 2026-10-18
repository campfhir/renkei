import { buildOptimizationPrompt, renderEvidence, type OptimizationEvidence } from './optimize';
import { parseOptimizationReply, parseOptimizationReport } from './optimization-report';
import type { StoredAgent } from './store';

const EVIDENCE: OptimizationEvidence = {
  windowDays: 30,
  stats: {
    runs: 12,
    succeeded: 8,
    failed: 4,
    avgTokensPerRun: 9_400,
    maxTokensPerRun: 21_000,
    avgTurnsPerRun: 6.5,
    avgToolCallsPerRun: 11.2,
  },
  failures: [
    {
      at: '2026-09-01T08:00:00.000Z',
      triggerKind: 'schedule',
      errorKind: 'budget',
      outcomeCode: null,
      error: 'The run used its 150 tool calls without finishing.',
      inputTokens: 3_000,
      outputTokens: 400,
      toolCalls: 150,
    },
  ],
  tools: [{ tool: 'jira_search_issues', calls: 140, failedCalls: 30, callShare: 93 }],
  samples: [
    {
      runId: 'r1',
      at: '2026-09-01T08:00:00.000Z',
      errorKind: 'budget',
      error: 'The run used its 150 tool calls without finishing.',
      turns: [
        {
          turn: 12,
          summary: 'Searching again with a different title.',
          calls: [{ tool: 'jira_search_issues', failed: true, result: 'No issues found.' }],
        },
      ],
    },
  ],
  limits: { minutes: 30, toolCalls: 150 },
};

const AGENT: StoredAgent = {
  id: 'agent-1',
  name: 'Ticket chaser',
  description: null,
  descriptionStatus: 'ok',
  reviewNotes: null,
  instructions: '## Goal\n\nFind the Jira ticket for the report.',
  tools: ['jira_search_issues'],
  revision: 3,
  llmModelId: null,
  enabled: true,
  guardrails: null,
  canAskQuestions: false,
  autoAcceptActions: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  triggers: [],
};

describe('renderEvidence', () => {
  it('states the window, the limits, the stats, the tool profile, and the failures', () => {
    const text = renderEvidence(EVIDENCE);
    expect(text).toContain('last 30 days');
    expect(text).toContain('Limits per run: 150 tool calls, 30 minutes');
    expect(text).toContain('12 finished (8 succeeded, 4 failed)');
    expect(text).toContain('6.5 model turns and 11.2 tool calls per run');
    expect(text).toContain('jira_search_issues: 140 calls, 30 failed; 93% of calls');
    expect(text).toContain('budget — The run used its 150 tool calls');
    expect(text).toContain('turn 12: Searching again');
    expect(text).toContain('FAILED jira_search_issues → No issues found.');
  });

  it('says so when there is nothing', () => {
    const text = renderEvidence({ ...EVIDENCE, failures: [], tools: [], samples: [] });
    expect(text).toContain('(none in the window)');
    expect(text).toContain('(no tool calls recorded in the window)');
    expect(text).not.toContain('How recent failed runs ended');
  });
});

describe('buildOptimizationPrompt', () => {
  it('includes the definition, the evidence, and the reply contract', () => {
    const prompt = buildOptimizationPrompt(AGENT, EVIDENCE);
    expect(prompt).toContain('# Ticket chaser');
    expect(prompt).toContain('=== EVIDENCE ===');
    expect(prompt).toContain('"revisionBrief"');
    expect(prompt).toContain('Reply with JSON only');
  });
});

describe('parseOptimizationReply', () => {
  const summary = { windowDays: 30, runs: 12, failures: 4, tokensPerRun: 9_400, stepsVersion: 3 };

  it('parses a fenced JSON reply and attaches the evidence summary', () => {
    const report = parseOptimizationReply(
      '```json\n' +
        JSON.stringify({
          summary: 'It keeps failing to find tickets.',
          findings: [
            {
              area: 'accuracy',
              severity: 'high',
              step: 'Find the ticket',
              issue: 'Exact-title search misses renamed tickets.',
              fix: 'Search by the summary text and the reporter instead.',
              evidence: '4 of 12 runs failed with not_found',
            },
            { area: 'nonsense', severity: 'huge', issue: 'x', fix: 'y' },
            { issue: 'missing fix' },
          ],
          revisionBrief: '1. In "Find the ticket", search by summary text.',
          expectedImpact: { failures: 'Most not_found failures go away.', tokens: null },
          extra: 'ignored',
        }) +
        '\n```',
      summary
    );
    expect(report).not.toBeNull();
    expect(report!.summary).toBe('It keeps failing to find tickets.');
    expect(report!.findings).toHaveLength(2);
    expect(report!.findings[0]).toMatchObject({
      area: 'accuracy',
      severity: 'high',
      step: 'Find the ticket',
    });
    // Unknown area/severity degrade to the defaults rather than dropping the finding.
    expect(report!.findings[1]).toMatchObject({ area: 'accuracy', severity: 'medium', step: null });
    expect(report!.revisionBrief).toContain('search by summary text');
    expect(report!.expectedImpact).toEqual({
      failures: 'Most not_found failures go away.',
      tokens: null,
    });
    expect(report!.evidence).toEqual(summary);
    expect(report!.draftId).toBeUndefined();
  });

  it('drops a brief when there are no findings', () => {
    const report = parseOptimizationReply(
      JSON.stringify({ summary: 'All good.', findings: [], revisionBrief: 'Nothing to change.' }),
      summary
    );
    expect(report!.revisionBrief).toBeNull();
  });

  it('returns null for prose, broken JSON, and a reply without a summary', () => {
    expect(parseOptimizationReply('I cannot help with that.', summary)).toBeNull();
    expect(parseOptimizationReply('{"summary": "x", ', summary)).toBeNull();
    expect(parseOptimizationReply('{"findings": []}', summary)).toBeNull();
  });
});

describe('parseOptimizationReport', () => {
  it('keeps a stored draftId and tolerates a missing evidence block', () => {
    const report = parseOptimizationReport({ summary: 'Stored.', draftId: 'd-1' });
    expect(report).toMatchObject({ summary: 'Stored.', draftId: 'd-1', findings: [] });
    expect(report!.evidence.runs).toBe(0);
  });
  it('rejects non-objects', () => {
    expect(parseOptimizationReport(null)).toBeNull();
    expect(parseOptimizationReport('nope')).toBeNull();
    expect(parseOptimizationReport([])).toBeNull();
  });
});
