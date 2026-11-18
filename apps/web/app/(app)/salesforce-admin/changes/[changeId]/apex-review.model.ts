/**
 * What a Salesforce admin change request's review page shows of Apex
 * (page.tsx): each class's or trigger's change as a diff the code
 * project's diff view reads, and the validation's tests — which ran, which
 * failed and why, each changed class's and trigger's coverage against the
 * bar, and whether they let the change deploy. Tested in
 * apex-review.model.test.ts.
 */

import {
  APEX_COVERAGE_PERCENT,
  apexTestVerdict,
  type ApexTestRun,
  type ApexUnit,
} from '@renkei/connector-salesforce';

const APEX_TYPES: Record<string, { folder: string; suffix: string }> = {
  ApexClass: { folder: 'classes', suffix: 'cls' },
  ApexTrigger: { folder: 'triggers', suffix: 'trigger' },
};

/**
 * A component's diff as git writes one (`diff --git`, `---`/`+++`, then
 * its hunks), named as the deploy names the file, so the diff view shows
 * a new class as new and a deleted one as deleted; null when it has none.
 */
export function apexDiffText(component: {
  type: string;
  name: string;
  action: 'create' | 'update' | 'delete';
  diff?: string;
}): string | null {
  const kind = APEX_TYPES[component.type];
  if (!kind || !component.diff) return null;
  const path = `${kind.folder}/${component.name}.${kind.suffix}`;
  const from = component.action === 'create' ? '/dev/null' : `a/${path}`;
  const to = component.action === 'delete' ? '/dev/null' : `b/${path}`;
  return `diff --git a/${path} b/${path}\n--- ${from}\n+++ ${to}\n${component.diff}`;
}

export interface ApexTestsView {
  /** The test classes every validation and deploy runs. */
  tests: string[];
  /** 'pending' while the validation runs or when it could not; else what its tests allow. */
  state: 'pending' | 'deploys' | 'blocked';
  ran: number;
  passed: number;
  failures: { test: string; message: string; trace: string | null }[];
  coverage: { name: string; kind: ApexUnit['kind']; percent: number; enough: boolean }[];
  /** Why it may not deploy, in the words the approval refusal uses. */
  problems: string[];
  threshold: number;
}

/** The validation's Apex tests as the page shows them; null for a change without Apex. */
export function apexTestsView(
  validation: { deployId: string; done: boolean; tests?: ApexTestRun } | { error: string } | null,
  payload: { apexTests?: string[]; apexMeasured?: ApexUnit[] } | null
): ApexTestsView | null {
  const tests = payload?.apexTests ?? [];
  if (tests.length === 0) return null;
  const base = {
    tests,
    ran: 0,
    passed: 0,
    failures: [],
    coverage: [],
    problems: [],
    threshold: APEX_COVERAGE_PERCENT,
  };
  if (!validation || 'error' in validation || !validation.done) {
    return { ...base, state: 'pending' };
  }
  const run = validation.tests;
  const verdict = apexTestVerdict(run, payload?.apexMeasured ?? []);
  return {
    ...base,
    state: verdict.ok ? 'deploys' : 'blocked',
    ran: run?.run ?? 0,
    passed: run ? run.run - run.failures.length : 0,
    failures: (run?.failures ?? []).map((failure) => ({
      test: `${failure.className}.${failure.method}`,
      message: failure.message,
      trace: failure.stackTrace ?? null,
    })),
    coverage: verdict.covered.map(({ unit, percent }) => ({
      name: unit.name,
      kind: unit.kind,
      percent,
      enough: percent >= APEX_COVERAGE_PERCENT,
    })),
    problems: verdict.ok ? [] : verdict.problems,
  };
}
