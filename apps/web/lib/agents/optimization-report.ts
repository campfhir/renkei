/**
 * The optimizer's report — its shape, and the parse of a model reply into
 * it. Pure, so the prompt/parse pair is testable without a database and
 * the client can import the types without dragging in `pg`.
 */

export type FindingArea = 'accuracy' | 'tokens' | 'reliability';
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface OptimizationFinding {
  area: FindingArea;
  severity: FindingSeverity;
  /** The step the finding is about, by name, when it is about one. */
  step: string | null;
  /** What is wrong, one or two sentences. */
  issue: string;
  /** The concrete edit the owner should make. */
  fix: string;
  /** Which numbers or failures the finding rests on — its receipt. */
  evidence: string | null;
}

export interface OptimizationEvidenceSummary {
  windowDays: number;
  runs: number;
  failures: number;
  /** Average tokens per run over the window, both directions summed. */
  tokensPerRun: number;
  stepsVersion: number;
}

export interface OptimizationReport {
  /** Two or three plain sentences for the owner. */
  summary: string;
  findings: OptimizationFinding[];
  /**
   * The revision, as prose the drafting model can act on — the thing the
   * "Draft these fixes" button hands to the builder's draft pipeline. Null
   * when the report found nothing worth changing.
   */
  revisionBrief: string | null;
  expectedImpact: { failures: string | null; tokens: string | null };
  evidence: OptimizationEvidenceSummary;
  /** Set once the owner turned the brief into a draft. */
  draftId?: string;
}

const MAX_FINDINGS = 8;
const MAX_TEXT = 1_000;
const MAX_BRIEF = 6_000;

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function areaOf(value: unknown): FindingArea {
  return value === 'tokens' || value === 'reliability' ? value : 'accuracy';
}

function severityOf(value: unknown): FindingSeverity {
  return value === 'high' || value === 'low' ? value : 'medium';
}

function findingsOf(value: unknown): OptimizationFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: OptimizationFinding[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record: {
      area?: unknown;
      severity?: unknown;
      step?: unknown;
      issue?: unknown;
      fix?: unknown;
      evidence?: unknown;
    } = entry;
    const issue = text(record.issue);
    const fix = text(record.fix);
    if (!issue || !fix) continue;
    findings.push({
      area: areaOf(record.area),
      severity: severityOf(record.severity),
      step: text(record.step, 200),
      issue,
      fix,
      evidence: text(record.evidence),
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

function evidenceOf(value: unknown): OptimizationEvidenceSummary {
  const record: {
    windowDays?: unknown;
    runs?: unknown;
    failures?: unknown;
    tokensPerRun?: unknown;
    stepsVersion?: unknown;
  } = typeof value === 'object' && value !== null ? value : {};
  const num = (candidate: unknown) =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
  return {
    windowDays: num(record.windowDays),
    runs: num(record.runs),
    failures: num(record.failures),
    tokensPerRun: num(record.tokensPerRun),
    stepsVersion: num(record.stepsVersion),
  };
}

/**
 * A stored report back into its shape — tolerant, since a row written by
 * an older build (or hand-edited) must still render rather than throw.
 */
export function parseOptimizationReport(value: unknown): OptimizationReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: {
    summary?: unknown;
    findings?: unknown;
    revisionBrief?: unknown;
    expectedImpact?: unknown;
    evidence?: unknown;
    draftId?: unknown;
  } = value;
  const summary = text(record.summary, 2_000);
  if (!summary) return null;
  const impact: { failures?: unknown; tokens?: unknown } =
    typeof record.expectedImpact === 'object' && record.expectedImpact !== null
      ? record.expectedImpact
      : {};
  return {
    summary,
    findings: findingsOf(record.findings),
    revisionBrief: text(record.revisionBrief, MAX_BRIEF),
    expectedImpact: { failures: text(impact.failures), tokens: text(impact.tokens) },
    evidence: evidenceOf(record.evidence),
    ...(typeof record.draftId === 'string' && record.draftId ? { draftId: record.draftId } : {}),
  };
}

/**
 * The model's reply, which is asked for as JSON and arrives as JSON in a
 * code fence often enough that the fence is stripped first. Null when the
 * reply is not a report at all — the caller turns that into a retry or a
 * failure, never into an empty report.
 */
export function parseOptimizationReply(
  raw: string,
  evidence: OptimizationEvidenceSummary
): OptimizationReport | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const report = parseOptimizationReport({ ...parsed, evidence, draftId: undefined });
  if (!report) return null;
  // A brief that only restates "nothing to change" is no brief.
  if (report.findings.length === 0) report.revisionBrief = null;
  return report;
}
