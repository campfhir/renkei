import { buildOptimizationPrompt, renderEvidence, type OptimizationEvidence } from './optimize';
import { parseOptimizationReply, parseOptimizationReport } from './optimization-report';
import type { AgentStepsDoc } from '@renkei/agents';
import type { StoredAgent } from './store';

const EVIDENCE: OptimizationEvidence = {
  windowDays: 30,
  stats: {
    runs: 12,
    succeeded: 8,
    failed: 4,
    avgTokensPerRun: 9_400,
    maxTokensPerRun: 21_000,
    avgAttemptsPerRun: 3.5,
  },
  failures: [
    {
      at: '2026-09-01T08:00:00.000Z',
      triggerKind: 'schedule',
      stepName: 'Find the ticket',
      errorKind: 'step_failed',
      outcomeCode: 'not_found',
      error: 'No issue matched the summary.',
      inputTokens: 3_000,
      outputTokens: 400,
      toolCalls: 2,
    },
  ],
  steps: [
    {
      stepId: 'a',
      stepName: 'Find the ticket',
      attempts: 20,
      failedAttempts: 4,
      avgInputTokens: 2_800,
      avgOutputTokens: 300,
      avgToolCalls: 1.5,
      tokenShare: 62,
    },
  ],
  samples: [
    {
      runId: 'r1',
      at: '2026-09-01T08:00:00.000Z',
      errorKind: 'step_failed',
      error: 'No issue matched the summary.',
      attempts: [
        {
          stepName: 'Find the ticket',
          attempt: 1,
          outcomeCode: 'not_found',
          summary: 'Searched by exact title and found nothing.',
          calls: [{ tool: 'jira_search_issues', failed: true, result: 'No issues found.' }],
        },
      ],
    },
  ],
};

const STEPS: AgentStepsDoc = {
  version: 3,
  steps: [
    {
      id: 'a',
      name: 'Find the ticket',
      instruction: [{ t: 'text', v: 'Find the Jira ticket for the report.' }],
      tool: 'jira_search_issues',
      maxAttempts: 3,
      failureHandling: [],
    },
  ],
};

const AGENT: StoredAgent = {
  id: 'agent-1',
  name: 'Ticket chaser',
  description: null,
  descriptionStatus: 'ok',
  reviewNotes: null,
  steps: STEPS,
  stepsVersion: 3,
  llmModelId: null,
  enabled: true,
  guardrails: null,
  blockedTools: [],
  canAskQuestions: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  triggers: [],
};

describe('renderEvidence', () => {
  it('states the window, the stats, the step profile, and the failures', () => {
    const text = renderEvidence(EVIDENCE);
    expect(text).toContain('last 30 days');
    expect(text).toContain('12 finished (8 succeeded, 4 failed)');
    expect(text).toContain('"Find the ticket": 20 attempts, 4 failed');
    expect(text).toContain('62% of tokens');
    expect(text).toContain('[not_found]');
    expect(text).toContain('FAILED jira_search_issues → No issues found.');
  });

  it('says so when there is nothing', () => {
    const text = renderEvidence({ ...EVIDENCE, failures: [], steps: [], samples: [] });
    expect(text).toContain('(none in the window)');
    expect(text).toContain('(no step attempts recorded in the window)');
    expect(text).not.toContain('What the failed attempts said');
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
