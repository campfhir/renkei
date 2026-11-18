/**
 * The code_salesforce_* tools: Apex in a code project, from the chat.
 *
 * - `code_salesforce_retrieve_apex` pulls classes and triggers from an
 *   org into the checkout, to start from what is live or catch up with an
 *   edit made in Setup;
 * - `code_salesforce_test_apex` sends the repository's classes and
 *   triggers to an org as a validation deploy that runs the named test
 *   classes — Salesforce compiles everything and runs the tests, and
 *   nothing changes — and reports the tests, the coverage and whether
 *   that would let it deploy;
 * - `code_salesforce_propose_apex` makes them a change request through
 *   the same pipeline as every other Salesforce admin change.
 *
 * The work is salesforce-apex.ts's, shared with the code pane's Apex
 * panel; these word its answers for the model. Local tools bound to one
 * checkout (tools.ts), on the chatting person's own Salesforce Admin
 * grant, behind the connector's Apex capability (`sfa-apex`).
 */

import { isRecord } from '@renkei/guards';
import type { ApexUnit } from '@renkei/connector-salesforce';
import type { SandboxClientError, SandboxTarget } from '@renkei/sandbox-client';
import type { McpToolResult } from '@renkei/mcp-client';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import {
  APEX_COVERAGE_PERCENT,
  MAX_APEX_UNITS,
  PROPOSE_TOOL,
  RETRIEVE_TOOL,
  TEST_TOOL,
  apexNames,
  apexTestStatus,
  failed,
  proposeApex,
  retrieveApex,
  startApexTests,
  type ApexFailure,
  type TestReport,
} from './salesforce-apex';

export { PROPOSE_TOOL, RETRIEVE_TOOL, TEST_TOOL };

/** How long a test run is waited on before handing back its deploy id to look again. */
const TEST_WAIT_MS = 8 * 60_000;
/** The turn waits on the tool a little past the run's own budget. */
const TEST_TOOL_TIMEOUT_MS = TEST_WAIT_MS + 60_000;
const NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,79}$';

export interface ApexToolDeps {
  target: SandboxTarget;
  /** The checkout, read at call time (a recovery moves it). */
  ref: { id: string };
  failed: (error: SandboxClientError) => McpToolResult;
}

const orgProperty = {
  type: 'string',
  maxLength: 80,
  description:
    'Which Salesforce org: an admin connector’s name or key (UAT, Production…). Optional only when the person is connected to one org.',
};
const namesProperty = (description: string) => ({
  type: 'array',
  items: { type: 'string', pattern: NAME_PATTERN },
  maxItems: MAX_APEX_UNITS,
  description,
});

/** A failure as the model reads it: the checkout's own error goes to its recovery. */
function refusal(deps: ApexToolDeps, failure: ApexFailure): McpToolResult {
  return failure.sandbox ? deps.failed(failure.sandbox) : errorResult(failure.error);
}

/** What a run's tests say, one line each, with the verdict. */
function reportLines(report: TestReport, testNames: readonly string[]): string[] {
  const lines: string[] = [];
  if (report.compile.length > 0) {
    lines.push(
      'Salesforce could not compile or deploy it:',
      ...report.compile.map((l) => `  • ${l}`)
    );
  }
  if (report.run) {
    lines.push(
      `Tests (${testNames.join(', ')}): ${report.run.run - report.run.failures.length} of ${report.run.run} passed.`
    );
  } else if (report.compile.length === 0) {
    lines.push('No tests ran.');
  }
  for (const { unit, percent } of report.coverage) {
    lines.push(`  Coverage of ${unit.name} (${unit.kind}): ${percent}%`);
  }
  if (report.errorMessage) lines.push(report.errorMessage);
  if (report.ok) {
    lines.push(
      `Every test passed and each changed class and trigger is at least ${APEX_COVERAGE_PERCENT}% covered: this would be allowed to deploy.`
    );
  } else {
    lines.push(
      `This would not be allowed to deploy (every test must pass, and each changed class and trigger be ${APEX_COVERAGE_PERCENT}% covered):`,
      ...report.problems.map((problem) => `  • ${problem}`),
      ...(report.compile.length > 0 ? ['  • It does not compile; see above.'] : [])
    );
  }
  return lines;
}

export function salesforceApexTools(deps: ApexToolDeps): LocalTool[] {
  const checkout = () => ({ target: deps.target, workspaceId: deps.ref.id });
  const orgOf = (args: Record<string, unknown>) =>
    typeof args.org === 'string' && args.org ? args.org : undefined;
  return [
    {
      def: {
        name: RETRIEVE_TOOL,
        description:
          'Pull Apex classes and triggers from a Salesforce org into this repository, in the ' +
          'Salesforce DX layout (classes/Foo.cls beside Foo.cls-meta.xml, under the default package ' +
          'directory sfdx-project.json names, else force-app/main/default; the project file is ' +
          'written when there is none). Use it to start from what is live, or to catch up with an ' +
          'edit someone made in Setup — a file already here is replaced, so commit first if it holds ' +
          'work. The repository is for a feature or project, not one org: pull from whichever org ' +
          'has what you need.',
        inputSchema: {
          type: 'object',
          properties: {
            org: orgProperty,
            names: namesProperty('The classes and triggers to pull, by name.'),
            kind: {
              type: 'string',
              enum: ['class', 'trigger'],
              description: 'Which they are; default looks for a class, then a trigger.',
            },
          },
          required: ['names'],
        },
      },
      async execute(input, context) {
        const args = isRecord(input) ? input : {};
        const result = await retrieveApex(
          checkout(),
          { subject: context.subject },
          {
            org: orgOf(args),
            names: apexNames(args.names),
            ...(args.kind === 'class' || args.kind === 'trigger' ? { kinds: [args.kind] } : {}),
          }
        );
        if (failed(result)) return refusal(deps, result);
        const lines = result.pulled.map(
          (unit) =>
            `${unit.kind === 'class' ? 'Class' : 'Trigger'} ${unit.name}${unit.object ? ` on ${unit.object}` : ''} → ${unit.path} (API ${unit.apiVersion}${unit.status === 'Inactive' ? ', switched off in the org' : ''}; ${
              unit.state === 'new'
                ? 'new here'
                : unit.state === 'same'
                  ? 'already the same here'
                  : 'replaced what was here'
            })`
        );
        if (result.wroteProject) lines.push('sfdx-project.json written: this repository had none.');
        const text = [
          result.pulled.length > 0
            ? `Pulled from ${result.where}:`
            : `Nothing was pulled from ${result.where}.`,
          ...lines,
          ...(result.problems.length > 0
            ? ['', 'Not pulled:', ...result.problems.map((p) => `  • ${p}`)]
            : []),
          ...(result.pulled.length > 0
            ? ['', 'Nothing is committed: review with code_git_status, then commit.']
            : []),
        ].join('\n');
        return result.pulled.length > 0 ? textResult(text) : errorResult(text);
      },
    },
    {
      def: {
        name: TEST_TOOL,
        description:
          'Run Apex tests in a Salesforce org — a sandbox or production — against this repository’s ' +
          'classes and triggers: they are sent as a validation deploy that runs the named test classes, ' +
          'so Salesforce compiles everything and runs the tests, and nothing in the org changes. ' +
          'Reports compile errors, each failing test, the coverage of each class and trigger sent, ' +
          `and whether that would be allowed to deploy (every test passing, each ${APEX_COVERAGE_PERCENT}% covered). ` +
          'Sends the Apex changed and not committed unless `names` says; a named test class this ' +
          'repository holds is sent too when the org does not have it as it is. A long run hands back ' +
          'its deploy id: call again with `deployId` to see how it ended.',
        inputSchema: {
          type: 'object',
          properties: {
            org: orgProperty,
            tests: namesProperty('The test classes to run (at least one).'),
            names: namesProperty(
              'The classes and triggers to send; default those changed and not committed.'
            ),
            deployId: {
              type: 'string',
              pattern: '^[A-Za-z0-9]{15,18}$',
              description: 'Instead: look at a run this tool started and handed back.',
            },
          },
        },
      },
      timeoutMs: TEST_TOOL_TIMEOUT_MS,
      async execute(input, context) {
        const args = isRecord(input) ? input : {};
        const caller = { subject: context.subject };
        const tests = apexNames(args.tests);
        let deployId = typeof args.deployId === 'string' ? args.deployId : '';
        let measured: ApexUnit[] | null = null;
        let sent: string[] = [];
        if (!deployId) {
          if (tests.length === 0) return errorResult('Name the test classes to run (`tests`).');
          const started = await startApexTests(checkout(), caller, {
            org: orgOf(args),
            tests,
            names: apexNames(args.names),
          });
          if (failed(started)) return refusal(deps, started);
          deployId = started.deployId;
          measured = started.measured;
          sent = started.sent.map(
            (unit) => `${unit.name}${unit.addedTest ? ' (test, new or changed)' : ''}`
          );
        }
        const report = await apexTestStatus(caller, {
          org: orgOf(args),
          deployId,
          measured,
          waitMs: TEST_WAIT_MS,
        });
        if (failed(report)) return refusal(deps, report);
        if (!report.done) {
          return textResult(
            `The run is still going in ${report.where} (${report.status}). Call ${TEST_TOOL} again with deployId ${deployId} to see how it ends.`
          );
        }
        return textResult(
          [
            `Test run ${deployId} in ${report.where} — a validation; nothing in the org changed.`,
            ...(sent.length > 0 ? [`Sent: ${sent.join(', ')}`] : []),
            '',
            ...reportLines(report, tests.length > 0 ? tests : ['as started']),
          ].join('\n')
        );
      },
    },
    {
      def: {
        name: PROPOSE_TOOL,
        description:
          'Propose this repository’s Apex to a Salesforce org as a change request — the same review ' +
          'and approval as every Salesforce admin change: Salesforce validates it running the named ' +
          'test classes, an operator approves it on the review page this returns (showing each ' +
          `class’s diff against the org), and it deploys only when every test passed and each class and trigger it changes is ${APEX_COVERAGE_PERCENT}% covered — in a sandbox as in production. ` +
          'Sends the classes and triggers named (default: those changed and not committed); ' +
          '`deactivateTriggers` switches triggers off (production allows it, and the source stays); ' +
          '`deleteClasses` deletes classes, which production cannot switch off — the repository keeps ' +
          'their source. Run the tests first with code_salesforce_test_apex. Commit and push the work ' +
          'too, so what was proposed is in the repository’s history.',
        inputSchema: {
          type: 'object',
          properties: {
            org: orgProperty,
            tests: namesProperty(
              'The test classes every validation and deploy of it runs (at least one).'
            ),
            names: namesProperty(
              'The classes and triggers to write; default those changed and not committed.'
            ),
            deactivateTriggers: namesProperty('Triggers to switch off, as they are in the org.'),
            deleteClasses: namesProperty('Classes to delete from the org.'),
            title: {
              type: 'string',
              maxLength: 200,
              description: 'One line; default from what it changes.',
            },
            reason: {
              type: 'string',
              maxLength: 1000,
              description: 'Why — shown to whoever approves it.',
            },
            replaces: {
              type: 'string',
              maxLength: 64,
              description:
                'An earlier change request this one replaces (yours, or a request in words it builds).',
            },
          },
          required: ['tests'],
        },
      },
      timeoutMs: TEST_TOOL_TIMEOUT_MS,
      async execute(input, context) {
        const args = isRecord(input) ? input : {};
        const proposed = await proposeApex(
          checkout(),
          { subject: context.subject, ...(context.origin ? { origin: context.origin } : {}) },
          {
            org: orgOf(args),
            tests: apexNames(args.tests),
            names: apexNames(args.names),
            deactivateTriggers: apexNames(args.deactivateTriggers),
            deleteClasses: apexNames(args.deleteClasses),
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
            ...(typeof args.replaces === 'string' && args.replaces
              ? { replaces: args.replaces }
              : {}),
          }
        );
        if (failed(proposed)) return refusal(deps, proposed);
        return textResult(proposed.text);
      },
    },
  ];
}
