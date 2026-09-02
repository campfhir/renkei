'use client';

/**
 * Improve: the optimizer's report for this agent, and the button that
 * asks for a new one.
 *
 * The pass is a job — start it, poll the latest, show what came back. A
 * report's findings are grouped by what they cost the owner (accuracy,
 * reliability, tokens) and each one says what to change. "Draft these
 * fixes" hands the report's brief to the builder's drafting pipeline;
 * this panel then watches THAT job too, and links to the builder once the
 * draft is ready — where it is offered, never applied on its own.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { AgentOptimization } from '@/lib/agents/optimization-store';
import type {
  FindingArea,
  FindingSeverity,
  OptimizationFinding,
} from '@/lib/agents/optimization-report';

const POLL_MS = 3_000;

const AREA_LABEL: Record<FindingArea, string> = {
  accuracy: 'Accuracy',
  reliability: 'Reliability',
  tokens: 'Token cost',
};

const SEVERITY_CLASS: Record<FindingSeverity, string> = {
  high: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

function Finding({ finding }: { finding: OptimizationFinding }) {
  return (
    <li className="rounded-md border border-gray-200 bg-white p-2.5 text-sm dark:border-gray-800 dark:bg-gray-950">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{AREA_LABEL[finding.area]}</span>
        {finding.step ? (
          <span className="text-xs text-gray-600 dark:text-gray-300">
            step &ldquo;{finding.step}&rdquo;
          </span>
        ) : null}
      </div>
      <p className="text-gray-900 dark:text-gray-100">{finding.issue}</p>
      <p className="mt-1 text-gray-700 dark:text-gray-300">
        <span className="font-medium">Fix:</span> {finding.fix}
      </p>
      {finding.evidence ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">Evidence:</span> {finding.evidence}
        </p>
      ) : null}
    </li>
  );
}

type DraftState = 'queued' | 'running' | 'succeeded' | 'failed' | null;

export default function ImprovePanel({
  slug,
  tenantId,
  agentId,
  initial,
}: {
  slug: string;
  tenantId: string;
  agentId: string;
  initial: AgentOptimization | null;
}) {
  const [optimization, setOptimization] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<DraftState>(null);

  const inFlight = optimization?.status === 'queued' || optimization?.status === 'running';
  const report = optimization?.status === 'succeeded' ? optimization.result : null;
  const draftId = report?.draftId ?? null;
  const analysisTokens = optimization ? optimization.inputTokens + optimization.outputTokens : 0;

  const refresh = useCallback(async () => {
    const result = await getJson<{ optimization: AgentOptimization | null }>(
      `/api/tenant/${tenantId}/agents/${agentId}/optimize`
    );
    if (result.data) setOptimization(result.data.optimization);
  }, [tenantId, agentId]);

  // Watch a running pass. The job outlives this page, so a missed poll is
  // cosmetic — the next open shows the latest report either way.
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  // Watch a drafting job started from this report, so the panel can say
  // "ready — open the builder" rather than sending the owner to look.
  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    const poll = async () => {
      const result = await getJson<{ draft?: { status: string } | null }>(
        `/api/tenant/${tenantId}/agents/draft/${draftId}`
      );
      if (cancelled) return;
      const status = result.data?.draft?.status;
      if (
        status === 'queued' ||
        status === 'running' ||
        status === 'succeeded' ||
        status === 'failed'
      ) {
        setDraftState(status);
      } else if (result.data && !result.data.draft) {
        // Pruned, or already loaded into the builder and gone. Nothing to watch.
        setDraftState(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [draftId, tenantId]);

  async function start() {
    setStarting(true);
    setError(null);
    const result = await sendJsonFull<{ optimizationId?: string; error?: string }>(
      `/api/tenant/${tenantId}/agents/${agentId}/optimize`,
      'POST',
      {}
    );
    setStarting(false);
    if (result.error || !result.data?.optimizationId) {
      setError(result.error ?? 'Could not start the analysis.');
      return;
    }
    await refresh();
  }

  async function apply() {
    if (!optimization) return;
    setApplying(true);
    setError(null);
    const result = await sendJsonFull<{ draftId?: string; error?: string }>(
      `/api/tenant/${tenantId}/agents/${agentId}/optimize/apply`,
      'POST',
      { optimizationId: optimization.id }
    );
    setApplying(false);
    if (result.error || !result.data?.draftId) {
      setError(result.error ?? 'Could not start drafting.');
      return;
    }
    setDraftState('queued');
    await refresh();
  }

  const analyzeLabel = report || optimization?.status === 'failed' ? 'Analyze again' : 'Analyze';

  return (
    <div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Your org&rsquo;s model reads this agent&rsquo;s recent failures and token spend and says
        what to change. Nothing is edited until you accept a draft in the builder.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={starting || inFlight}
          onClick={() => void start()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {inFlight ? 'Analyzing…' : starting ? 'Starting…' : analyzeLabel}
        </button>
        {optimization?.finishedAt ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            last run {new Date(optimization.finishedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {inFlight ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Reading the last {optimization?.request.windowDays ?? 30} days of runs and asking the
          model. This can take a minute or two; you can leave the page.
        </p>
      ) : null}

      {optimization?.status === 'failed' ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <p>{optimization.error ?? 'The analysis failed.'}</p>
          {optimization.errorDetail ? (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] opacity-80">
              {optimization.errorDetail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {report ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-gray-900 dark:text-gray-100">{report.summary}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Based on {report.evidence.runs} run{report.evidence.runs === 1 ? '' : 's'} (
            {report.evidence.failures} failed) over {report.evidence.windowDays} days, averaging{' '}
            {formatTokens(report.evidence.tokensPerRun)} tokens per run. The analysis itself cost{' '}
            {formatTokens(analysisTokens)} tokens.
          </p>

          {report.findings.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Nothing worth changing was found.
            </p>
          ) : (
            <ul className="space-y-2">
              {report.findings.map((finding, index) => (
                <Finding key={`${finding.step}:${index}`} finding={finding} />
              ))}
            </ul>
          )}

          {report.expectedImpact.failures || report.expectedImpact.tokens ? (
            <dl className="grid gap-1 text-xs text-gray-700 dark:text-gray-300">
              {report.expectedImpact.failures ? (
                <div>
                  <dt className="inline font-medium">Failures: </dt>
                  <dd className="inline">{report.expectedImpact.failures}</dd>
                </div>
              ) : null}
              {report.expectedImpact.tokens ? (
                <div>
                  <dt className="inline font-medium">Tokens: </dt>
                  <dd className="inline">{report.expectedImpact.tokens}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {report.revisionBrief ? (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-2.5 dark:border-gray-800 dark:bg-gray-900/60">
              {draftId ? (
                <div className="text-xs">
                  {draftState === 'succeeded' ? (
                    <>
                      <p className="text-gray-800 dark:text-gray-200">
                        The revised steps are ready. The builder will offer them when it opens —
                        review, then save or discard.
                      </p>
                      <Link
                        href={`/${slug}/agents/${agentId}/edit`}
                        className="mt-1.5 inline-block rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
                      >
                        Review in the builder
                      </Link>
                    </>
                  ) : draftState === 'failed' ? (
                    <p className="text-red-700 dark:text-red-300">
                      Drafting the revision failed. Open the builder and try describing the fixes
                      there, or analyze again.
                    </p>
                  ) : draftState === null ? (
                    <p className="text-gray-600 dark:text-gray-400">
                      A draft was made from this report.{' '}
                      <Link
                        href={`/${slug}/agents/${agentId}/edit`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Open the builder
                      </Link>
                      .
                    </p>
                  ) : (
                    <p className="text-gray-600 dark:text-gray-400">
                      Drafting the revised steps… this takes a minute or two. You can leave the
                      page.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-700 dark:text-gray-300">
                      What would change
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-gray-800 dark:text-gray-200">
                      {report.revisionBrief}
                    </pre>
                  </details>
                  <button
                    type="button"
                    disabled={applying}
                    onClick={() => void apply()}
                    className="mt-2 rounded-md border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-900/30"
                  >
                    {applying ? 'Starting…' : 'Draft these fixes'}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {!optimization ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No analysis yet.</p>
      ) : null}
    </div>
  );
}
