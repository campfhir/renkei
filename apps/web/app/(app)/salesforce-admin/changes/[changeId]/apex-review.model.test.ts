import { unifiedDiff, type ApexTestRun } from '@renkei/connector-salesforce';
import { parseUnifiedDiff } from '@/lib/code/diff';
import { apexDiffText, apexTestsView } from './apex-review.model';

const payload = {
  apexTests: ['BillingServiceTest'],
  apexMeasured: [{ kind: 'class' as const, name: 'BillingService' }],
};
const validated = (tests: ApexTestRun | null) => ({
  deployId: '0Af000000000001',
  done: true,
  ...(tests ? { tests } : {}),
});

describe('the diff a reviewer reads', () => {
  it('names a changed class as the deploy does, both sides', () => {
    expect(
      apexDiffText({
        type: 'ApexClass',
        name: 'BillingService',
        action: 'update',
        diff: '@@ -1 +1 @@\n-a\n+b',
      })
    ).toBe(
      'diff --git a/classes/BillingService.cls b/classes/BillingService.cls\n' +
        '--- a/classes/BillingService.cls\n+++ b/classes/BillingService.cls\n@@ -1 +1 @@\n-a\n+b'
    );
  });

  it('shows a new trigger as new and a deleted class as deleted', () => {
    expect(
      apexDiffText({
        type: 'ApexTrigger',
        name: 'AccountTrigger',
        action: 'create',
        diff: '@@ -0,0 +1 @@\n+x',
      })
    ).toContain('--- /dev/null\n+++ b/triggers/AccountTrigger.trigger');
    expect(
      apexDiffText({
        type: 'ApexClass',
        name: 'OldHelper',
        action: 'delete',
        diff: '@@ -1 +0,0 @@\n-x',
      })
    ).toContain('--- a/classes/OldHelper.cls\n+++ /dev/null');
  });

  it('reads in the diff view as git’s own would: one file, its counts, a new one as new', () => {
    const changed = apexDiffText({
      type: 'ApexClass',
      name: 'BillingService',
      action: 'update',
      diff: unifiedDiff('public class A {\n  x = 1;\n}', 'public class A {\n  x = 2;\n  y = 3;\n}'),
    });
    const [file, ...rest] = parseUnifiedDiff(changed ?? '');
    expect(rest).toEqual([]);
    expect(file).toMatchObject({
      path: 'classes/BillingService.cls',
      status: 'modified',
      added: 2,
      deleted: 1,
    });
    const created = apexDiffText({
      type: 'ApexTrigger',
      name: 'AccountTrigger',
      action: 'create',
      diff: unifiedDiff('', 'trigger AccountTrigger on Account (before insert) {}'),
    });
    expect(parseUnifiedDiff(created ?? '')[0]).toMatchObject({
      path: 'triggers/AccountTrigger.trigger',
      status: 'added',
      added: 1,
    });
  });

  it('has nothing to show for a switched-off trigger or a component that is not Apex', () => {
    expect(
      apexDiffText({ type: 'ApexTrigger', name: 'AccountTrigger', action: 'update' })
    ).toBeNull();
    expect(
      apexDiffText({ type: 'CustomField', name: 'Account.Tier__c', action: 'create', diff: 'x' })
    ).toBeNull();
  });
});

describe('the tests a reviewer reads', () => {
  it('shows nothing for a change without Apex', () => {
    expect(apexTestsView(validated(null), { apexTests: [] })).toBeNull();
    expect(apexTestsView(validated(null), null)).toBeNull();
  });

  it('waits while the validation runs, and when it could not run', () => {
    expect(apexTestsView({ deployId: 'x', done: false }, payload)?.state).toBe('pending');
    expect(apexTestsView({ error: 'Salesforce timed out' }, payload)?.state).toBe('pending');
  });

  it('says the change may deploy when every test passed and the class is covered enough', () => {
    expect(
      apexTestsView(
        validated({
          run: 3,
          failures: [],
          coverage: [{ name: 'BillingService', type: 'Class', lines: 10, uncovered: 2 }],
          warnings: [],
        }),
        payload
      )
    ).toEqual({
      tests: ['BillingServiceTest'],
      state: 'deploys',
      ran: 3,
      passed: 3,
      failures: [],
      coverage: [{ name: 'BillingService', kind: 'class', percent: 80, enough: true }],
      problems: [],
      threshold: 80,
    });
  });

  it('shows a failing test with its trace, a class under the bar, and why it cannot deploy', () => {
    const view = apexTestsView(
      validated({
        run: 2,
        failures: [
          {
            className: 'BillingServiceTest',
            method: 'taxes',
            message: 'Expected 2, got 1',
            stackTrace: 'Class.BillingServiceTest.taxes: line 3',
          },
        ],
        coverage: [{ name: 'BillingService', type: 'Class', lines: 10, uncovered: 3 }],
        warnings: [],
      }),
      payload
    );
    expect(view).toMatchObject({
      state: 'blocked',
      ran: 2,
      passed: 1,
      failures: [
        {
          test: 'BillingServiceTest.taxes',
          message: 'Expected 2, got 1',
          trace: 'Class.BillingServiceTest.taxes: line 3',
        },
      ],
      coverage: [{ name: 'BillingService', percent: 70, enough: false }],
    });
    expect(view?.problems).toHaveLength(2);
  });

  it('cannot deploy when the validation kept no test results', () => {
    expect(apexTestsView(validated(null), payload)).toMatchObject({
      state: 'blocked',
      problems: ['No tests ran. Name the test classes that exercise this change.'],
    });
  });
});
