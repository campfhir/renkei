/**
 * The code_salesforce_* tools: Apex in a code project.
 *
 * A code project's repository holds Apex in the Salesforce DX layout
 * (`force-app/main/default/classes/Foo.cls` beside its `-meta.xml`), for
 * a feature or a project rather than for one org; these tools carry it
 * between the repository and whichever org a call names:
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
 *   the same pipeline as every other Salesforce admin change (the
 *   validation runs the tests; an operator approves on the review page;
 *   it deploys only when every test passed and each class and trigger it
 *   changes is 80% covered). A trigger is taken out by switching it off;
 *   a class, which production cannot switch off, by deleting it.
 *
 * Local tools bound to one checkout (tools.ts), on the chatting person's
 * own Salesforce Admin grant, behind the connector's Apex capability
 * (`sfa-apex`, off by default), checked on every call against the one
 * connection it runs on.
 */

import {
  APEX_COVERAGE_PERCENT,
  SALESFORCE_API_VERSION,
  SFDX_SOURCE_ROOT,
  apexNameSuggestionQuery,
  apexPackage,
  apexSourcePath,
  apexTestVerdict,
  apexUnitOfPath,
  isTestClass,
  readApexMeta,
  apexMetaXml,
  unifiedDiff,
  type ApexKind,
  type ApexStatus,
  type ApexUnit,
  type ApexUpsert,
  type DeployOutcome,
} from '@renkei/connector-salesforce';
import {
  sbWorkspaceGitStatus,
  sbWorkspaceRead,
  sbWorkspaceWrite,
  type SandboxClientError,
  type SandboxTarget,
} from '@renkei/sandbox-client';
import type { McpToolResult } from '@renkei/mcp-client';
import { isRecord } from '@renkei/guards';
import {
  errorResult,
  textResult,
  type LocalTool,
  type LocalToolContext,
} from '@/lib/chat/local-tools';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import {
  resolveSalesforceAccess,
  sfQuery,
  str,
  type SalesforceAccess,
} from '@/lib/mcp-tools/salesforce/client';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import { salesforceAdminScopeFor } from '@/lib/mcp-tools/salesforce-admin/scopes';
import { proposeAndValidate, refusesChanges } from '@/lib/mcp-tools/salesforce-admin/shared';
import { APEX_KIND, readLiveApex, type LiveApex } from '@/lib/salesforce-admin/apex';
import { failureLines, startDeploy, waitForDeploy } from '@/lib/salesforce-admin/deploy';
import type { ComponentView, Precondition } from '@/lib/salesforce-admin/plan';

export const RETRIEVE_TOOL = 'code_salesforce_retrieve_apex';
export const TEST_TOOL = 'code_salesforce_test_apex';
export const PROPOSE_TOOL = 'code_salesforce_propose_apex';

/** How long a test run is waited on before handing back its deploy id to look again. */
const TEST_WAIT_MS = 8 * 60_000;
/** The turn waits on the tool a little past the run's own budget. */
const TEST_TOOL_TIMEOUT_MS = TEST_WAIT_MS + 60_000;
/** Classes and triggers one call carries. */
const MAX_UNITS = 50;
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
  maxItems: MAX_UNITS,
  description,
});

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (entry): entry is string => typeof entry === 'string' && /^[A-Za-z]\w*$/.test(entry)
          )
        ),
      ]
    : [];
}

/** The person's Salesforce Admin connection to the org named, with the Apex capability — or why not. */
async function adminAccess(
  context: LocalToolContext,
  tool: string,
  org: string | undefined
): Promise<SalesforceAccess | string> {
  return orgCall.run({ ...(org ? { org } : {}), tool }, () =>
    resolveSalesforceAccess(
      { subject: context.subject },
      SALESFORCE_ADMIN_KIND,
      salesforceAdminScopeFor
    )
  );
}

/** A file of the checkout, whole; null when there is none. */
async function readRepoFile(
  deps: ApexToolDeps,
  path: string
): Promise<string | null | McpToolResult> {
  const read = await sbWorkspaceRead(deps.target, { id: deps.ref.id, path });
  if (read.ok) return read.val.text;
  const error = read.err;
  if (
    error.kind === 'op' &&
    error.type === 'not_found' &&
    !/workspace/i.test(error.message ?? '')
  ) {
    return null;
  }
  return deps.failed(error);
}

const isResult = (value: unknown): value is McpToolResult =>
  isRecord(value) && Array.isArray(value.content);

/**
 * Where this repository keeps its source: the default package directory
 * `sfdx-project.json` names (`<path>/main/default`), else the Salesforce DX
 * default; and whether the project file is there at all.
 */
async function sourceRoot(
  deps: ApexToolDeps
): Promise<{ root: string; hasProject: boolean } | McpToolResult> {
  const project = await readRepoFile(deps, 'sfdx-project.json');
  if (isResult(project)) return project;
  if (project === null) return { root: SFDX_SOURCE_ROOT, hasProject: false };
  try {
    const parsed: unknown = JSON.parse(project);
    const dirs =
      isRecord(parsed) && Array.isArray(parsed.packageDirectories) ? parsed.packageDirectories : [];
    const chosen = dirs.find((dir) => isRecord(dir) && dir.default === true) ?? dirs[0];
    const path =
      isRecord(chosen) && typeof chosen.path === 'string' ? chosen.path.replace(/\/+$/, '') : '';
    return { root: path ? `${path}/main/default` : SFDX_SOURCE_ROOT, hasProject: true };
  } catch {
    return { root: SFDX_SOURCE_ROOT, hasProject: true };
  }
}

/** A class or trigger as the repository holds it. */
interface RepoApex extends ApexUnit {
  path: string;
  body: string;
  apiVersion: string;
  status: ApexStatus;
}

/** The class or trigger called `name` in the repository (a class first), or null. */
async function readRepoApex(
  deps: ApexToolDeps,
  root: string,
  name: string,
  kinds: readonly ApexKind[] = ['class', 'trigger']
): Promise<RepoApex | null | McpToolResult> {
  for (const kind of kinds) {
    const path = apexSourcePath({ kind, name }, root);
    const body = await readRepoFile(deps, path);
    if (isResult(body)) return body;
    if (body === null) continue;
    const meta = await readRepoFile(deps, `${path}-meta.xml`);
    if (isResult(meta)) return meta;
    const { apiVersion, status } =
      meta === null
        ? { apiVersion: SALESFORCE_API_VERSION, status: 'Active' as const }
        : readApexMeta(meta);
    return { kind, name, path, body, apiVersion, status };
  }
  return null;
}

/** The classes and triggers changed in the checkout and not yet committed, by name. */
async function changedApex(deps: ApexToolDeps): Promise<string[] | McpToolResult> {
  const status = await sbWorkspaceGitStatus(deps.target, { id: deps.ref.id });
  if (!status.ok) return deps.failed(status.err);
  const names = new Set<string>();
  for (const line of status.val.changes.split('\n')) {
    if (!line.trim() || line.slice(0, 2).includes('D')) continue;
    const path = line.slice(3).split(' -> ').pop()?.replace(/^"|"$/g, '') ?? '';
    const unit = apexUnitOfPath(path);
    if (unit) names.add(unit.name);
  }
  return [...names];
}

/** Live Apex by name, the org's own: a class first unless `kinds` says. */
async function findLive(
  context: LocalToolContext,
  access: SalesforceAccess,
  name: string,
  kinds: readonly ApexKind[] = ['class', 'trigger']
): Promise<LiveApex | null | string> {
  for (const kind of kinds) {
    const live = await readLiveApex({ subject: context.subject }, access, { kind, name });
    if (live !== null) return live;
  }
  return null;
}

async function suggestionsFor(
  context: LocalToolContext,
  access: SalesforceAccess,
  name: string
): Promise<string> {
  const found: string[] = [];
  for (const kind of ['class', 'trigger'] as const) {
    const page = await sfQuery(
      { subject: context.subject },
      access,
      apexNameSuggestionQuery(kind, name)
    );
    if (page.ok) {
      for (const row of page.records) {
        if (!str(row.NamespacePrefix)) found.push(`${str(row.Name)} (${kind})`);
      }
    }
  }
  return found.length > 0 ? ` Names that contain it: ${found.join(', ')}.` : '';
}

function where(access: SalesforceAccess): string {
  return `${access.connectorName}${access.sandbox ? ' (sandbox)' : ' (production)'}`;
}

/** The classes and triggers a test run or proposal sends, read from the repository. */
interface Selection {
  upserts: RepoApex[];
  /** Repository test classes added because a named test is among them and differs from the org. */
  addedTests: string[];
}

/**
 * The repository's `names` (default: the Apex changed and not committed),
 * plus each named test class the repository holds that the org does not
 * have as it is — a new test has to deploy beside what it tests.
 */
async function selectApex(
  deps: ApexToolDeps,
  context: LocalToolContext,
  access: SalesforceAccess,
  root: string,
  names: string[],
  tests: string[]
): Promise<Selection | McpToolResult> {
  let wanted = names;
  if (wanted.length === 0) {
    const changed = await changedApex(deps);
    if (isResult(changed)) return changed;
    wanted = changed;
  }
  const upserts: RepoApex[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const unit = await readRepoApex(deps, root, name);
    if (isResult(unit)) return unit;
    if (unit) upserts.push(unit);
    else missing.push(name);
  }
  if (missing.length > 0) {
    return errorResult(
      `Not in the repository under ${root}: ${missing.join(', ')}. ${RETRIEVE_TOOL} pulls a class or trigger from the org into it.`
    );
  }
  const addedTests: string[] = [];
  for (const test of tests) {
    if (
      upserts.some(
        (unit) => unit.kind === 'class' && unit.name.toLowerCase() === test.toLowerCase()
      )
    )
      continue;
    const unit = await readRepoApex(deps, root, test, ['class']);
    if (isResult(unit)) return unit;
    if (!unit) continue;
    const live = await findLive(context, access, test, ['class']);
    if (typeof live === 'string')
      return errorResult(`Could not read ${test} in ${where(access)}: ${live}`);
    if (!live || live.body !== unit.body) {
      upserts.push(unit);
      addedTests.push(test);
    }
  }
  return { upserts, addedTests };
}

/** What a run's tests say, one line each, with the verdict. */
function testReport(
  outcome: DeployOutcome,
  measured: readonly ApexUnit[],
  testNames: readonly string[]
): {
  lines: string[];
  ok: boolean;
} {
  const lines: string[] = [];
  const compile = outcome.failures.filter((failure) => failure.type !== '' || failure.name !== '');
  if (compile.length > 0) {
    lines.push('Salesforce could not compile or deploy it:');
    lines.push(
      ...failureLines({ ...outcome, failures: compile, errorMessage: undefined }).map(
        (line) => `  • ${line}`
      )
    );
  }
  const run = outcome.tests;
  if (run) {
    lines.push(
      `Tests (${testNames.join(', ')}): ${run.run - run.failures.length} of ${run.run} passed.`
    );
  } else if (compile.length === 0) {
    lines.push('No tests ran.');
  }
  const verdict = apexTestVerdict(run, measured);
  for (const { unit, percent } of verdict.covered) {
    lines.push(`  Coverage of ${unit.name} (${unit.kind}): ${percent}%`);
  }
  if (outcome.errorMessage && compile.length === 0) lines.push(outcome.errorMessage);
  const ok = verdict.ok && compile.length === 0 && outcome.success;
  if (ok) {
    lines.push(
      `Every test passed and each changed class and trigger is at least ${APEX_COVERAGE_PERCENT}% covered: this would be allowed to deploy.`
    );
  } else {
    lines.push(
      `This would not be allowed to deploy (every test must pass, and each changed class and trigger be ${APEX_COVERAGE_PERCENT}% covered):`,
      ...(verdict.ok ? [] : verdict.problems.map((problem) => `  • ${problem}`)),
      ...(compile.length > 0 ? ['  • It does not compile; see above.'] : [])
    );
  }
  return { lines, ok };
}

/** The classes and triggers whose coverage counts: everything written, test classes left out. */
function measuredOf(
  upserts: readonly { kind: ApexKind; name: string; body: string; status?: ApexStatus }[]
): ApexUnit[] {
  return upserts
    .filter(
      (unit) => !(unit.kind === 'class' && isTestClass(unit.body)) && unit.status !== 'Inactive'
    )
    .map(({ kind, name }) => ({ kind, name }));
}

function toUpsert(unit: RepoApex): ApexUpsert {
  return {
    kind: unit.kind,
    name: unit.name,
    body: unit.body,
    apiVersion: unit.apiVersion,
    status: unit.status,
  };
}

export function salesforceApexTools(deps: ApexToolDeps): LocalTool[] {
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
        const names = strings(args.names);
        if (names.length === 0) return errorResult('Name at least one class or trigger to pull.');
        const kinds: ApexKind[] =
          args.kind === 'class' || args.kind === 'trigger' ? [args.kind] : ['class', 'trigger'];
        const access = await adminAccess(
          context,
          RETRIEVE_TOOL,
          typeof args.org === 'string' ? args.org : undefined
        );
        if (typeof access === 'string') return errorResult(access);
        const located = await sourceRoot(deps);
        if (isResult(located)) return located;
        const { root } = located;
        const lines: string[] = [];
        const problems: string[] = [];
        for (const name of names) {
          const live = await findLive(context, access, name, kinds);
          if (typeof live === 'string') {
            problems.push(`${name}: ${live}`);
            continue;
          }
          if (!live) {
            problems.push(
              `${name}: ${where(access)} has no Apex ${kinds.length === 1 ? kinds[0] : 'class or trigger'} of its own by that name.${await suggestionsFor(context, access, name)}`
            );
            continue;
          }
          const path = apexSourcePath(live, root);
          const before = await readRepoFile(deps, path);
          if (isResult(before)) return before;
          for (const [file, content] of [
            [path, live.body],
            [`${path}-meta.xml`, apexMetaXml(live.kind, live.apiVersion, live.status)],
          ] as const) {
            const written = await sbWorkspaceWrite(deps.target, {
              id: deps.ref.id,
              path: file,
              content,
            });
            if (!written.ok) return deps.failed(written.err);
          }
          const state =
            before === null
              ? 'new here'
              : before === live.body
                ? 'already the same here'
                : 'replaced what was here';
          lines.push(
            `${live.kind === 'class' ? 'Class' : 'Trigger'} ${live.name}${live.object ? ` on ${live.object}` : ''} → ${path} (API ${live.apiVersion}${live.status === 'Inactive' ? ', switched off in the org' : ''}; ${state})`
          );
        }
        if (!located.hasProject && lines.length > 0) {
          const project = {
            packageDirectories: [{ path: 'force-app', default: true }],
            sourceApiVersion: SALESFORCE_API_VERSION,
          };
          const written = await sbWorkspaceWrite(deps.target, {
            id: deps.ref.id,
            path: 'sfdx-project.json',
            content: `${JSON.stringify(project, null, 2)}\n`,
          });
          if (!written.ok) return deps.failed(written.err);
          lines.push('sfdx-project.json written: this repository had none.');
        }
        const text = [
          lines.length > 0
            ? `Pulled from ${where(access)}:`
            : `Nothing was pulled from ${where(access)}.`,
          ...lines,
          ...(problems.length > 0 ? ['', 'Not pulled:', ...problems.map((p) => `  • ${p}`)] : []),
          ...(lines.length > 0
            ? ['', 'Nothing is committed: review with code_git_status, then commit.']
            : []),
        ].join('\n');
        return lines.length > 0 ? textResult(text) : errorResult(text);
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
        const access = await adminAccess(
          context,
          TEST_TOOL,
          typeof args.org === 'string' ? args.org : undefined
        );
        if (typeof access === 'string') return errorResult(access);
        const tests = strings(args.tests);
        const located = await sourceRoot(deps);
        if (isResult(located)) return located;

        let deployId = typeof args.deployId === 'string' ? args.deployId : '';
        let measured: ApexUnit[] = [];
        let sent: string[] = [];
        if (!deployId) {
          if (tests.length === 0) return errorResult('Name the test classes to run (`tests`).');
          const selection = await selectApex(
            deps,
            context,
            access,
            located.root,
            strings(args.names),
            tests
          );
          if (isResult(selection)) return selection;
          if (selection.upserts.length === 0) {
            return errorResult(
              'Nothing to send: no Apex is changed and not committed. Name the classes and triggers to test (`names`).'
            );
          }
          const built = apexPackage({ upserts: selection.upserts.map(toUpsert) });
          const started = await startDeploy({ subject: context.subject }, access, built.files, {
            checkOnly: true,
            tests,
          });
          if (!started.ok)
            return errorResult(`Salesforce would not start the run: ${started.error}`);
          deployId = started.outcome.id;
          measured = measuredOf(selection.upserts);
          sent = selection.upserts.map(
            (unit) =>
              `${unit.name}${selection.addedTests.includes(unit.name) ? ' (test, new or changed)' : ''}`
          );
        }
        const waited = await waitForDeploy(
          { subject: context.subject },
          access,
          deployId,
          TEST_WAIT_MS
        );
        if (!waited.ok) return errorResult(`Could not read the run ${deployId}: ${waited.error}`);
        const outcome = waited.outcome;
        if (!outcome.done) {
          return textResult(
            `The run is still going in ${where(access)} (${outcome.status}). Call ${TEST_TOOL} again with deployId ${deployId} to see how it ends.`
          );
        }
        // Looking again by id: measure what the run covered, since what was sent is not kept.
        if (measured.length === 0) {
          measured = (outcome.tests?.coverage ?? []).map((entry) => ({
            kind:
              entry.type.toLowerCase() === 'trigger' ? ('trigger' as const) : ('class' as const),
            name: entry.name,
          }));
        }
        const report = testReport(outcome, measured, tests.length > 0 ? tests : ['as started']);
        return textResult(
          [
            `Test run ${deployId} in ${where(access)} — a validation; nothing in the org changed.`,
            ...(sent.length > 0 ? [`Sent: ${sent.join(', ')}`] : []),
            '',
            ...report.lines,
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
        const access = await adminAccess(
          context,
          PROPOSE_TOOL,
          typeof args.org === 'string' ? args.org : undefined
        );
        if (typeof access === 'string') return errorResult(access);
        const refused = await refusesChanges(access);
        if (refused) return errorResult(refused);
        const tests = strings(args.tests);
        if (tests.length === 0) {
          return errorResult(
            'Name the test classes every validation and deploy of this runs (`tests`).'
          );
        }
        const deactivate = strings(args.deactivateTriggers);
        const deletes = strings(args.deleteClasses);
        const located = await sourceRoot(deps);
        if (isResult(located)) return located;
        const named = strings(args.names);
        // With only switches-off or deletes asked for, nothing else is sent by default.
        const selection =
          named.length === 0 && (deactivate.length > 0 || deletes.length > 0)
            ? await selectApex(deps, context, access, located.root, [], tests).then((s) =>
                isResult(s)
                  ? s
                  : { ...s, upserts: s.upserts.filter((u) => s.addedTests.includes(u.name)) }
              )
            : await selectApex(deps, context, access, located.root, named, tests);
        if (isResult(selection)) return selection;

        const upserts: ApexUpsert[] = [];
        const components: ComponentView[] = [];
        const preconditions: Precondition[] = [];
        const summary: string[] = [];
        const skipped: string[] = [];
        for (const unit of selection.upserts) {
          const live = await readLiveApex({ subject: context.subject }, access, unit);
          if (typeof live === 'string')
            return errorResult(`Could not read ${unit.name} in ${where(access)}: ${live}`);
          if (live && live.body === unit.body && live.status === unit.status) {
            skipped.push(unit.name);
            continue;
          }
          if (live && live.kind !== unit.kind) {
            return errorResult(
              `${unit.name} is a ${live.kind} in ${where(access)} but a ${unit.kind} here.`
            );
          }
          upserts.push(toUpsert(unit));
          preconditions.push(
            live
              ? {
                  kind: 'apex-unchanged',
                  type: unit.kind,
                  name: unit.name,
                  fingerprint: live.fingerprint,
                }
              : { kind: 'apex-absent', type: unit.kind, name: unit.name }
          );
          const diff = unifiedDiff(live?.body ?? '', unit.body);
          const added = diff.split('\n').filter((l) => l.startsWith('+')).length;
          const removed = diff.split('\n').filter((l) => l.startsWith('-')).length;
          components.push({
            type: unit.kind === 'class' ? 'ApexClass' : 'ApexTrigger',
            name: unit.name,
            action: live ? 'update' : 'create',
            rows: [
              ...(isTestClass(unit.body) ? [{ label: 'Kind', value: 'test class' }] : []),
              { label: 'Lines', value: `+${added} −${removed}` },
              ...(live && live.status !== unit.status
                ? [{ label: 'Status', value: unit.status, from: live.status }]
                : []),
              ...(live && live.apiVersion !== unit.apiVersion
                ? [{ label: 'API version', value: unit.apiVersion, from: live.apiVersion }]
                : []),
              { label: 'From the repository', value: unit.path },
            ],
            ...(diff ? { diff } : {}),
          });
          summary.push(
            `• ${live ? 'Change' : 'New'} ${unit.kind} ${unit.name} (+${added} −${removed})`
          );
        }
        for (const name of deactivate) {
          const live = await readLiveApex({ subject: context.subject }, access, {
            kind: 'trigger',
            name,
          });
          if (typeof live === 'string')
            return errorResult(`Could not read the trigger ${name}: ${live}`);
          if (!live) return errorResult(`${where(access)} has no trigger ${name} to switch off.`);
          if (upserts.some((u) => u.kind === 'trigger' && u.name === name)) {
            return errorResult(`${name} is both written and switched off; do one.`);
          }
          if (live.status === 'Inactive') {
            skipped.push(`${name} (already off)`);
            continue;
          }
          upserts.push({
            kind: 'trigger',
            name,
            body: live.body,
            apiVersion: live.apiVersion,
            status: 'Inactive',
          });
          preconditions.push({
            kind: 'apex-unchanged',
            type: 'trigger',
            name,
            fingerprint: live.fingerprint,
          });
          components.push({
            type: 'ApexTrigger',
            name,
            action: 'update',
            rows: [
              { label: 'Status', value: 'Inactive', from: 'Active' },
              ...(live.object ? [{ label: 'On', value: live.object }] : []),
              { label: 'Source', value: 'unchanged; it stays in the org, switched off' },
            ],
          });
          summary.push(
            `• Switch off the trigger ${name}${live.object ? ` on ${live.object}` : ''}`
          );
        }
        const deleted: ApexUnit[] = [];
        for (const name of deletes) {
          const live = await readLiveApex({ subject: context.subject }, access, {
            kind: 'class',
            name,
          });
          if (typeof live === 'string')
            return errorResult(`Could not read the class ${name}: ${live}`);
          if (!live) return errorResult(`${where(access)} has no class ${name} to delete.`);
          if (upserts.some((u) => u.kind === 'class' && u.name === name)) {
            return errorResult(`${name} is both written and deleted; do one.`);
          }
          deleted.push({ kind: 'class', name });
          preconditions.push({
            kind: 'apex-unchanged',
            type: 'class',
            name,
            fingerprint: live.fingerprint,
          });
          components.push({
            type: 'ApexClass',
            name,
            action: 'delete',
            rows: [
              { label: 'Lines', value: `${live.body.split('\n').length} removed` },
              {
                label: 'Its source',
                value: `kept in the repository (${apexSourcePath(live, located.root)}) — Salesforce cannot switch a class off in production, only delete it`,
              },
            ],
            diff: unifiedDiff(live.body, ''),
          });
          summary.push(`• Delete the class ${name}`);
        }
        if (upserts.length === 0 && deleted.length === 0) {
          return errorResult(
            `Nothing to propose: ${skipped.length > 0 ? `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} already as ${where(access)} has ${skipped.length === 1 ? 'it' : 'them'}.` : 'no Apex is changed and not committed; name what to send (`names`).'}`
          );
        }
        const built = apexPackage({ upserts, deletes: deleted });
        const switchedOff = (u: ApexUpsert) =>
          u.kind === 'trigger' && u.status === 'Inactive' && deactivate.includes(u.name);
        const what = [
          ...upserts.map((u) => (switchedOff(u) ? `${u.name} off` : u.name)),
          ...deleted.map((u) => `${u.name} deleted`),
        ];
        const title =
          typeof args.title === 'string' && args.title.trim()
            ? args.title.trim()
            : `Apex: ${what.slice(0, 4).join(', ')}${what.length > 4 ? ` and ${what.length - 4} more` : ''}`;
        const proposed = await proposeAndValidate(
          { subject: context.subject, origin: context.origin },
          access,
          {
            kind: APEX_KIND,
            title,
            ...(typeof args.reason === 'string' && args.reason.trim()
              ? { reason: args.reason.trim() }
              : {}),
            ...(typeof args.replaces === 'string' && args.replaces
              ? { replaces: args.replaces }
              : {}),
            payload: {
              ...built,
              components,
              preconditions,
              dataSteps: [],
              apexTests: tests,
              apexMeasured: measuredOf(upserts),
            },
            summary: [
              ...summary,
              `  Tests every validation and deploy runs: ${tests.join(', ')}`,
              ...(skipped.length > 0
                ? [`  Left out, already as the org has them: ${skipped.join(', ')}`]
                : []),
            ],
          }
        );
        const text = proposed.content.map((part) => part.text).join('\n');
        return 'isError' in proposed && proposed.isError ? errorResult(text) : textResult(text);
      },
    },
  ];
}
