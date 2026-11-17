import {
  apexMetaXml,
  apexPackage,
  apexSourcePath,
  apexUnitOfPath,
  isTestClass,
  lineDiff,
  readApexMeta,
  unifiedDiff,
} from './apex-deploy';
import { apexTestVerdict, parseRunTestResult, type ApexTestRun } from './apex-tests';
import { parseDeployResult } from './metadata';

describe('where Apex lives in a repository', () => {
  it('writes classes and triggers in the Salesforce DX layout', () => {
    expect(apexSourcePath({ kind: 'class', name: 'BillingService' })).toBe(
      'force-app/main/default/classes/BillingService.cls'
    );
    expect(apexSourcePath({ kind: 'trigger', name: 'AccountTrigger' }, 'billing')).toBe(
      'billing/triggers/AccountTrigger.trigger'
    );
  });

  it('reads a class or trigger, or its meta file, from any package directory', () => {
    expect(apexUnitOfPath('force-app/main/default/classes/BillingService.cls')).toEqual({
      kind: 'class',
      name: 'BillingService',
      meta: false,
    });
    expect(apexUnitOfPath('billing/triggers/AccountTrigger.trigger-meta.xml')).toEqual({
      kind: 'trigger',
      name: 'AccountTrigger',
      meta: true,
    });
    expect(apexUnitOfPath('README.md')).toBeNull();
    expect(apexUnitOfPath('force-app/main/default/classes/Wrong.trigger')).toBeNull();
    expect(apexUnitOfPath('force-app/main/default/lwc/thing/thing.js')).toBeNull();
  });

  it('round-trips a meta file, defaulting what it leaves out', () => {
    expect(readApexMeta(apexMetaXml('trigger', '61.0', 'Inactive'))).toEqual({
      apiVersion: '61.0',
      status: 'Inactive',
    });
    expect(readApexMeta('<ApexClass/>')).toEqual({ apiVersion: '68.0', status: 'Active' });
  });

  it('knows a test class by its annotation, not by a comment or string that mentions one', () => {
    expect(isTestClass('@isTest\nprivate class BillingServiceTest {}')).toBe(true);
    expect(isTestClass('@IsTest(SeeAllData=false) public class T {}')).toBe(true);
    expect(isTestClass('// @isTest someday\npublic class BillingService {}')).toBe(false);
    expect(
      isTestClass(
        "public class BillingService { String s = '@isTest'; @isTest static void x() {} }"
      )
    ).toBe(false);
  });
});

describe('the package an Apex change deploys', () => {
  it('carries each class and trigger with its meta file, and a manifest naming them', () => {
    const built = apexPackage({
      upserts: [
        {
          kind: 'class',
          name: 'BillingService',
          body: 'public class BillingService {}',
          apiVersion: '62.0',
        },
        {
          kind: 'trigger',
          name: 'AccountTrigger',
          body: 'trigger AccountTrigger on Account (before insert) {}',
          apiVersion: '62.0',
          status: 'Inactive',
        },
      ],
    });
    expect(Object.keys(built.files).sort()).toEqual([
      'classes/BillingService.cls',
      'classes/BillingService.cls-meta.xml',
      'package.xml',
      'triggers/AccountTrigger.trigger',
      'triggers/AccountTrigger.trigger-meta.xml',
    ]);
    expect(built.files['triggers/AccountTrigger.trigger-meta.xml']).toContain(
      '<status>Inactive</status>'
    );
    expect(built.files['package.xml']).toContain(
      '<members>BillingService</members>\n        <name>ApexClass</name>'
    );
    expect(built.members).toEqual([
      { type: 'ApexClass', member: 'BillingService' },
      { type: 'ApexTrigger', member: 'AccountTrigger' },
    ]);
  });

  it('deletes classes after the rest deploys, so a reference taken out goes with them', () => {
    const built = apexPackage({
      upserts: [
        { kind: 'class', name: 'Caller', body: 'public class Caller {}', apiVersion: '62.0' },
      ],
      deletes: [{ kind: 'class', name: 'OldHelper' }],
    });
    expect(built.files['destructiveChangesPost.xml']).toContain(
      '<members>OldHelper</members>\n        <name>ApexClass</name>'
    );
    expect(built.files['package.xml']).not.toContain('OldHelper');
  });
});

describe('whether the tests let a change deploy', () => {
  const run = (overrides: Partial<ApexTestRun> = {}): ApexTestRun => ({
    run: 4,
    failures: [],
    coverage: [
      { name: 'BillingService', type: 'Class', lines: 100, uncovered: 15 },
      { name: 'AccountTrigger', type: 'Trigger', lines: 10, uncovered: 3 },
    ],
    warnings: [],
    ...overrides,
  });

  it('lets a change deploy when every test passed and each changed class is 80% covered', () => {
    expect(apexTestVerdict(run(), [{ kind: 'class', name: 'billingservice' }])).toEqual({
      ok: true,
      covered: [{ unit: { kind: 'class', name: 'billingservice' }, percent: 85 }],
    });
  });

  it('stops a change with a trigger under 80% covered, saying by how much', () => {
    const verdict = apexTestVerdict(run(), [{ kind: 'trigger', name: 'AccountTrigger' }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.problems).toEqual([
      'AccountTrigger (trigger) is 70% covered (7 of 10 lines); it needs 80%.',
    ]);
  });

  it('stops a change with one failing test, naming it', () => {
    const verdict = apexTestVerdict(
      run({
        failures: [
          {
            className: 'BillingServiceTest',
            method: 'chargesTax',
            message: 'System.AssertException: Expected 10, got 8',
            stackTrace: 'Class.BillingServiceTest.chargesTax: line 12, column 1\nmore',
          },
        ],
      }),
      []
    );
    expect(verdict.ok ? [] : verdict.problems).toEqual([
      'BillingServiceTest.chargesTax failed: System.AssertException: Expected 10, got 8 (Class.BillingServiceTest.chargesTax: line 12, column 1)',
    ]);
  });

  it('stops a change no test ran for, and one whose class no test touched', () => {
    expect(apexTestVerdict(undefined, [])).toMatchObject({
      ok: false,
      problems: ['No tests ran. Name the test classes that exercise this change.'],
    });
    expect(apexTestVerdict(run(), [{ kind: 'class', name: 'Untested' }])).toMatchObject({
      ok: false,
      problems: ['Untested (class) is not covered at all: no test that ran exercises it.'],
    });
  });

  it('counts a class with no lines that run (an interface) as covered', () => {
    expect(
      apexTestVerdict(
        run({ coverage: [{ name: 'Shape', type: 'Class', lines: 0, uncovered: 0 }] }),
        [{ kind: 'class', name: 'Shape' }]
      ).ok
    ).toBe(true);
  });
});

describe('reading a deploy’s test results', () => {
  it('reads tests, failures and coverage, one-element lists and string numbers included', () => {
    const outcome = parseDeployResult({
      deployResult: {
        id: '0Af000000000001',
        done: 'true',
        success: 'false',
        status: 'Failed',
        checkOnly: true,
        details: {
          componentFailures: [],
          runTestResult: {
            numTestsRun: '3',
            numFailures: '1',
            failures: { name: 'BillingServiceTest', methodName: 'chargesTax', message: 'boom' },
            codeCoverage: [
              {
                name: 'BillingService',
                type: 'Class',
                numLocations: '20',
                numLocationsNotCovered: '2',
              },
            ],
            codeCoverageWarnings: {
              name: 'BillingService',
              message: 'Test coverage of selected Apex Class is 70%',
            },
          },
        },
      },
    });
    expect(outcome.tests).toEqual({
      run: 3,
      failures: [{ className: 'BillingServiceTest', method: 'chargesTax', message: 'boom' }],
      coverage: [{ name: 'BillingService', type: 'Class', lines: 20, uncovered: 2 }],
      warnings: ['BillingService: Test coverage of selected Apex Class is 70%'],
    });
  });

  it('leaves tests out of a deploy that ran none', () => {
    expect(parseDeployResult({ deployResult: { id: 'x', details: {} } }).tests).toBeUndefined();
    expect(parseRunTestResult({})).toBeUndefined();
  });
});

describe('the diff a reviewer reads', () => {
  it('keeps unchanged lines and marks what went and what came', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: ' ', text: 'd' },
      { op: '+', text: 'e' },
    ]);
  });

  it('rebuilds both sides exactly from a large class with edits scattered through it', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const after = before.flatMap((line, i) =>
      i % 250 === 0
        ? [`${line} changed`]
        : i % 333 === 0
          ? []
          : i % 400 === 0
            ? [line, 'added']
            : [line]
    );
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff.filter((l) => l.op !== '+').map((l) => l.text)).toEqual(before);
    expect(diff.filter((l) => l.op !== '-').map((l) => l.text)).toEqual(after);
    // Shortest: only the touched lines are marked.
    expect(diff.filter((l) => l.op !== ' ').length).toBeLessThan(40);
  });

  it('shows a new class as all added and a deleted one as all removed', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { op: '+', text: 'x' },
      { op: '+', text: 'y' },
    ]);
    expect(lineDiff('x', '')).toEqual([{ op: '-', text: 'x' }]);
  });

  it('cuts a unified diff to the changes and three lines around each', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
    const after = before.replace('l5', 'L5').replace('l25', 'L25');
    expect(unifiedDiff(before, after)).toBe(
      [
        '@@ -2,7 +2,7 @@',
        ' l2',
        ' l3',
        ' l4',
        '-l5',
        '+L5',
        ' l6',
        ' l7',
        ' l8',
        '@@ -22,7 +22,7 @@',
        ' l22',
        ' l23',
        ' l24',
        '-l25',
        '+L25',
        ' l26',
        ' l27',
        ' l28',
      ].join('\n')
    );
    expect(unifiedDiff('same', 'same')).toBe('');
  });
});
