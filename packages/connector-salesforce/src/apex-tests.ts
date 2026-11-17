/**
 * What an Apex test run said, and whether it lets a change deploy: every
 * test passed, and each class and trigger the change writes covered at
 * least APEX_COVERAGE_PERCENT (apex-deploy.ts says why).
 */

import { asRecord } from '@renkei/guards';
import type { ApexUnit } from './apex';

/** Every test must pass, and every changed class and trigger be covered at least this much. */
export const APEX_COVERAGE_PERCENT = 80;

export interface ApexTestFailure {
  /** The test class. */
  className: string;
  method: string;
  message: string;
  stackTrace?: string;
}

export interface ApexCoverage {
  name: string;
  /** Class or Trigger. */
  type: string;
  /** Lines that can run. */
  lines: number;
  uncovered: number;
}

export interface ApexTestRun {
  run: number;
  failures: ApexTestFailure[];
  coverage: ApexCoverage[];
  /** Salesforce's own coverage warnings (its 75% rule), as it words them. */
  warnings: string[];
}

const record = asRecord;
const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const count = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) || 0 : 0;
/** REST sends a one-element list as the element itself. */
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

/** A deploy's `details.runTestResult`, or undefined when it ran no tests. */
export function parseRunTestResult(details: unknown): ApexTestRun | undefined {
  const raw = record(details).runTestResult;
  if (raw === undefined || raw === null) return undefined;
  const result = record(raw);
  return {
    run: count(result.numTestsRun),
    failures: list(result.failures).map((entry) => {
      const failure = record(entry);
      const trace = text(failure.stackTrace);
      return {
        className: text(failure.name),
        method: text(failure.methodName),
        message: text(failure.message),
        ...(trace ? { stackTrace: trace } : {}),
      };
    }),
    coverage: list(result.codeCoverage).map((entry) => {
      const coverage = record(entry);
      return {
        name: text(coverage.name),
        type: text(coverage.type),
        lines: count(coverage.numLocations),
        uncovered: count(coverage.numLocationsNotCovered),
      };
    }),
    warnings: list(result.codeCoverageWarnings).flatMap((entry) => {
      const warning = record(entry);
      const message = text(warning.message);
      if (!message) return [];
      const name = text(warning.name);
      return [name ? `${name}: ${message}` : message];
    }),
  };
}

/** A class's or trigger's coverage as a whole percentage; 100 when it has no lines that run. */
export function coveragePercent(coverage: ApexCoverage): number {
  if (coverage.lines <= 0) return 100;
  return Math.floor(((coverage.lines - coverage.uncovered) / coverage.lines) * 100);
}

export type ApexTestVerdict =
  | { ok: true; covered: { unit: ApexUnit; percent: number }[] }
  | { ok: false; problems: string[]; covered: { unit: ApexUnit; percent: number }[] };

/**
 * Whether a test run lets a change deploy: tests ran, every one passed,
 * and each of `measured` — the classes and triggers the change writes,
 * test classes left out — is at least APEX_COVERAGE_PERCENT covered.
 */
export function apexTestVerdict(
  run: ApexTestRun | undefined,
  measured: readonly ApexUnit[]
): ApexTestVerdict {
  const problems: string[] = [];
  const covered: { unit: ApexUnit; percent: number }[] = [];
  if (!run || run.run === 0) {
    problems.push('No tests ran. Name the test classes that exercise this change.');
  }
  for (const failure of run?.failures ?? []) {
    problems.push(
      `${failure.className}.${failure.method} failed: ${failure.message}` +
        (failure.stackTrace ? ` (${failure.stackTrace.split('\n')[0]})` : '')
    );
  }
  if (run && run.run > 0) {
    for (const unit of measured) {
      const type = unit.kind === 'class' ? 'class' : 'trigger';
      const found = run.coverage.find(
        (entry) =>
          entry.name.toLowerCase() === unit.name.toLowerCase() && entry.type.toLowerCase() === type
      );
      if (!found) {
        problems.push(
          `${unit.name} (${type}) is not covered at all: no test that ran exercises it.`
        );
        covered.push({ unit, percent: 0 });
        continue;
      }
      const percent = coveragePercent(found);
      covered.push({ unit, percent });
      if (percent < APEX_COVERAGE_PERCENT) {
        problems.push(
          `${unit.name} (${type}) is ${percent}% covered (${found.lines - found.uncovered} of ${found.lines} lines); it needs ${APEX_COVERAGE_PERCENT}%.`
        );
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems, covered } : { ok: true, covered };
}
