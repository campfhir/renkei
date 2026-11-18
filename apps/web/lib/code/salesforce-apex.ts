/**
 * Apex in a code project's checkout, carried to and from Salesforce: what
 * the code_salesforce_* tools (salesforce-apex-tools.ts) and the code
 * pane's Apex panel (its routes under
 * app/api/code/projects/[projectId]/chats/[chatId]/salesforce-apex) both
 * stand on, so the chat and the panel do the same thing the same way.
 *
 * The repository holds Apex in the Salesforce DX layout
 * (`force-app/main/default/classes/Foo.cls` beside its `-meta.xml`), for a
 * feature or a project rather than for one org. Everything here runs on
 * the person's own Salesforce Admin grant, behind the connector's Apex
 * capability (`sfa-apex`), checked against the one connection each call
 * runs on; every answer is structured, and each caller words it.
 *
 * Failures come back as `{ error }`, with the sandbox worker's own error
 * beside it when the checkout was the trouble (a tool hands that to its
 * recovery: a lost checkout is cloned again).
 */

import {
  APEX_COVERAGE_PERCENT,
  SALESFORCE_API_VERSION,
  SFDX_SOURCE_ROOT,
  apexMetaXml,
  apexNameSuggestionQuery,
  apexPackage,
  apexSourcePath,
  apexTestVerdict,
  apexUnitOfPath,
  isTestClass,
  readApexMeta,
  soqlContains,
  takesChanges,
  unifiedDiff,
  type ApexKind,
  type ApexStatus,
  type ApexTestRun,
  type ApexUnit,
  type ApexUpsert,
  type DeployOutcome,
} from '@renkei/connector-salesforce';
import {
  clientFailure,
  sbWorkspaceFind,
  sbWorkspaceGitStatus,
  sbWorkspaceRead,
  sbWorkspaceWrite,
  type SandboxClientError,
  type SandboxTarget,
} from '@renkei/sandbox-client';
import { isRecord } from '@renkei/guards';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import {
  resolveSalesforceAccess,
  sfQuery,
  str,
  type SalesforceAccess,
} from '@/lib/mcp-tools/salesforce/client';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import { salesforceAdminScopeFor } from '@/lib/mcp-tools/salesforce-admin/scopes';
import { proposeChange, refusesChanges } from '@/lib/mcp-tools/salesforce-admin/shared';
import { APEX_KIND, readLiveApex, type LiveApex } from '@/lib/salesforce-admin/apex';
import { failureLines, startDeploy, waitForDeploy } from '@/lib/salesforce-admin/deploy';
import type { ComponentView, Precondition } from '@/lib/salesforce-admin/plan';
import type { Validation } from '@/lib/salesforce-admin/change-requests';
import { APEX_SCOPE, salesforceApexAvailable } from './salesforce-apex-access';

export const RETRIEVE_TOOL = 'code_salesforce_retrieve_apex';
export const TEST_TOOL = 'code_salesforce_test_apex';
export const PROPOSE_TOOL = 'code_salesforce_propose_apex';

/** Classes and triggers one call carries. */
export const MAX_APEX_UNITS = 50;

/** The checkout a call works in. */
export interface ApexCheckout {
  target: SandboxTarget;
  workspaceId: string;
}

/** Who calls, and the deployment's address for links. */
export interface ApexCaller {
  subject: string;
  origin?: string;
}

export interface ApexFailure {
  error: string;
  /** The sandbox worker's error, when the checkout was the trouble. */
  sandbox?: SandboxClientError;
}

export const failed = (value: unknown): value is ApexFailure =>
  isRecord(value) && typeof value.error === 'string';

function sandboxFailure(error: SandboxClientError): ApexFailure {
  return { error: clientFailure(error).message, sandbox: error };
}

/** Names as a caller gave them: Apex identifiers, each once. */
export function apexNames(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (entry): entry is string =>
              typeof entry === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(entry)
          )
        ),
      ].slice(0, MAX_APEX_UNITS)
    : [];
}

/** The person's Salesforce Admin connection to the org named, with the Apex capability — or why not. */
export async function apexAccess(
  caller: ApexCaller,
  tool: string,
  org: string | undefined
): Promise<SalesforceAccess | ApexFailure> {
  const access = await orgCall.run({ ...(org ? { org } : {}), tool }, () =>
    resolveSalesforceAccess(
      { subject: caller.subject },
      SALESFORCE_ADMIN_KIND,
      salesforceAdminScopeFor
    )
  );
  return typeof access === 'string' ? { error: access } : access;
}

export function whereOf(access: SalesforceAccess): string {
  return `${access.connectorName}${access.sandbox ? ' (sandbox)' : ' (production)'}`;
}

/** A file of the checkout, whole; null when there is none. */
async function readRepoFile(
  checkout: ApexCheckout,
  path: string
): Promise<string | null | ApexFailure> {
  const read = await sbWorkspaceRead(checkout.target, { id: checkout.workspaceId, path });
  if (read.ok) return read.val.text;
  const error = read.err;
  if (
    error.kind === 'op' &&
    error.type === 'not_found' &&
    !/workspace/i.test(error.message ?? '')
  ) {
    return null;
  }
  return sandboxFailure(error);
}

/**
 * Where this repository keeps its source: the default package directory
 * `sfdx-project.json` names (`<path>/main/default`), else the Salesforce DX
 * default; and whether the project file is there at all.
 */
export async function sourceRoot(
  checkout: ApexCheckout
): Promise<{ root: string; hasProject: boolean } | ApexFailure> {
  const project = await readRepoFile(checkout, 'sfdx-project.json');
  if (failed(project)) return project;
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
export interface RepoApex extends ApexUnit {
  path: string;
  body: string;
  apiVersion: string;
  status: ApexStatus;
}

/** The class or trigger called `name` in the repository (a class first), or null. */
async function readRepoApex(
  checkout: ApexCheckout,
  root: string,
  name: string,
  kinds: readonly ApexKind[] = ['class', 'trigger']
): Promise<RepoApex | null | ApexFailure> {
  for (const kind of kinds) {
    const path = apexSourcePath({ kind, name }, root);
    const body = await readRepoFile(checkout, path);
    if (failed(body)) return body;
    if (body === null) continue;
    const meta = await readRepoFile(checkout, `${path}-meta.xml`);
    if (failed(meta)) return meta;
    const { apiVersion, status } =
      meta === null
        ? { apiVersion: SALESFORCE_API_VERSION, status: 'Active' as const }
        : readApexMeta(meta);
    return { kind, name, path, body, apiVersion, status };
  }
  return null;
}

export interface ChangedApex extends ApexUnit {
  path: string;
  /** As git status has it. */
  status: 'modified' | 'new' | 'deleted';
}

/** The classes and triggers changed in the checkout and not yet committed. */
export async function changedApex(checkout: ApexCheckout): Promise<ChangedApex[] | ApexFailure> {
  const status = await sbWorkspaceGitStatus(checkout.target, { id: checkout.workspaceId });
  if (!status.ok) return sandboxFailure(status.err);
  const seen = new Map<string, ChangedApex>();
  for (const line of status.val.changes.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).split(' -> ').pop()?.replace(/^"|"$/g, '') ?? '';
    const unit = apexUnitOfPath(path);
    if (!unit) continue;
    const key = `${unit.kind}:${unit.name}`;
    // The source file names the change; a meta file alone counts as modified.
    if (seen.has(key) && unit.meta) continue;
    seen.set(key, {
      kind: unit.kind,
      name: unit.name,
      path: unit.meta ? path.replace(/-meta\.xml$/, '') : path,
      status: code.includes('D')
        ? 'deleted'
        : code.includes('?') || code.includes('A')
          ? 'new'
          : 'modified',
    });
  }
  return [...seen.values()];
}

/** Live Apex by name, the org's own: a class first unless `kinds` says. */
async function findLive(
  caller: ApexCaller,
  access: SalesforceAccess,
  name: string,
  kinds: readonly ApexKind[] = ['class', 'trigger']
): Promise<LiveApex | null | string> {
  for (const kind of kinds) {
    const live = await readLiveApex({ subject: caller.subject }, access, { kind, name });
    if (live !== null) return live;
  }
  return null;
}

async function suggestionsFor(
  caller: ApexCaller,
  access: SalesforceAccess,
  name: string
): Promise<string> {
  const found: string[] = [];
  for (const kind of ['class', 'trigger'] as const) {
    const page = await sfQuery(
      { subject: caller.subject },
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
  checkout: ApexCheckout,
  caller: ApexCaller,
  access: SalesforceAccess,
  root: string,
  names: string[],
  tests: string[]
): Promise<Selection | ApexFailure> {
  let wanted = names;
  if (wanted.length === 0) {
    const changed = await changedApex(checkout);
    if (failed(changed)) return changed;
    wanted = changed.filter((unit) => unit.status !== 'deleted').map((unit) => unit.name);
  }
  const upserts: RepoApex[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const unit = await readRepoApex(checkout, root, name);
    if (failed(unit)) return unit;
    if (unit) upserts.push(unit);
    else missing.push(name);
  }
  if (missing.length > 0) {
    return {
      error: `Not in the repository under ${root}: ${missing.join(', ')}. Pull a class or trigger from the org into it first.`,
    };
  }
  const addedTests: string[] = [];
  for (const test of tests) {
    if (
      upserts.some(
        (unit) => unit.kind === 'class' && unit.name.toLowerCase() === test.toLowerCase()
      )
    ) {
      continue;
    }
    const unit = await readRepoApex(checkout, root, test, ['class']);
    if (failed(unit)) return unit;
    if (!unit) continue;
    const live = await findLive(caller, access, test, ['class']);
    if (typeof live === 'string')
      return { error: `Could not read ${test} in ${whereOf(access)}: ${live}` };
    if (!live || live.body !== unit.body) {
      upserts.push(unit);
      addedTests.push(test);
    }
  }
  return { upserts, addedTests };
}

/** The classes and triggers whose coverage counts: everything written, test classes and switched-off triggers left out. */
export function measuredOf(
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

// ——— the panel's view of the checkout ———

export interface ApexOrg {
  key: string;
  name: string;
  sandbox: boolean;
  /** Takes change requests: any sandbox, production only where an admin allowed it. */
  takesChanges: boolean;
}

export interface ApexPanelStatus {
  /** The person holds an admin connection with the Apex capability. */
  available: boolean;
  /** The checkout holds Apex or a Salesforce DX project: the panel is offered. */
  present: boolean;
  root: string;
  /** The orgs the person's Apex capability reaches. */
  orgs: ApexOrg[];
  changed: ChangedApex[];
  /** The repository's test classes, by name — what a run may name. */
  testClasses: string[];
  /** Every class and trigger in the repository. */
  units: (ApexUnit & { path: string })[];
}

/** Paths of every class and trigger in the checkout (any package directory). */
async function apexFiles(checkout: ApexCheckout): Promise<string[] | ApexFailure> {
  const paths: string[] = [];
  for (const glob of ['**/classes/*.cls', '**/triggers/*.trigger']) {
    const found = await sbWorkspaceFind(checkout.target, {
      id: checkout.workspaceId,
      glob,
      max: 2000,
    });
    if (!found.ok) return sandboxFailure(found.err);
    paths.push(...found.val.paths);
  }
  return paths.filter((path) => !path.includes('node_modules/'));
}

/** The orgs where the person's admin connection carries the Apex capability. */
async function apexOrgs(subject: string): Promise<ApexOrg[]> {
  const connectors = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).filter(
    (org) => org.enabled
  );
  const connections = await listSalesforceConnections(
    subject,
    connectors,
    SALESFORCE_ADMIN_KIND.provider
  );
  return connectors
    .filter((org) =>
      connections.some((c) => c.connector === org.key && c.requestedScopes.includes(APEX_SCOPE))
    )
    .map((org) => ({
      key: org.key,
      name: org.name,
      sandbox: org.sandbox,
      takesChanges: takesChanges(org),
    }));
}

/**
 * What the code pane's Apex panel needs to decide whether to show itself
 * and what to offer: whether the person may use it, whether the checkout
 * holds Apex, which orgs, what changed, and the test classes there are.
 * Reads the test classes' heads only, to tell them apart.
 */
export async function apexPanelStatus(
  checkout: ApexCheckout,
  caller: ApexCaller
): Promise<ApexPanelStatus | ApexFailure> {
  const [available, located, files] = await Promise.all([
    salesforceApexAvailable(caller.subject).catch(() => false),
    sourceRoot(checkout),
    apexFiles(checkout),
  ]);
  if (failed(located)) return located;
  if (failed(files)) return files;
  const units = files.flatMap((path) => {
    const unit = apexUnitOfPath(path);
    return unit && !unit.meta ? [{ kind: unit.kind, name: unit.name, path }] : [];
  });
  const present = located.hasProject || units.length > 0;
  if (!available || !present) {
    return {
      available,
      present,
      root: located.root,
      orgs: [],
      changed: [],
      testClasses: [],
      units,
    };
  }
  const [orgs, changed] = await Promise.all([apexOrgs(caller.subject), changedApex(checkout)]);
  if (failed(changed)) return changed;
  const testClasses: string[] = [];
  // A test class says so before its first `class`: its name usually ends
  // in Test, and only those are opened to look.
  for (const unit of units.filter((u) => u.kind === 'class' && /test/i.test(u.name))) {
    const body = await readRepoFile(checkout, unit.path);
    if (typeof body === 'string' && isTestClass(body)) testClasses.push(unit.name);
  }
  return {
    available,
    present,
    root: located.root,
    orgs,
    changed,
    testClasses: testClasses.sort(),
    units,
  };
}

export interface OrgApexEntry extends ApexUnit {
  status: ApexStatus;
  object?: string;
}

/** The org's own classes and triggers whose names contain `query`, for the panel's Pull search. */
export async function searchOrgApex(
  caller: ApexCaller,
  input: { org?: string; query: string }
): Promise<{ where: string; entries: OrgApexEntry[] } | ApexFailure> {
  const access = await apexAccess(caller, RETRIEVE_TOOL, input.org);
  if (failed(access)) return access;
  const like = input.query.trim() ? `Name LIKE ${soqlContains(input.query.trim())} AND ` : '';
  const entries: OrgApexEntry[] = [];
  for (const kind of ['class', 'trigger'] as const) {
    const object = kind === 'class' ? 'ApexClass' : 'ApexTrigger';
    const page = await sfQuery(
      { subject: caller.subject },
      access,
      `SELECT Name, Status${kind === 'trigger' ? ', TableEnumOrId' : ''} FROM ${object} ` +
        `WHERE ${like}NamespacePrefix = null ORDER BY Name LIMIT 50`
    );
    if (!page.ok) return { error: page.error };
    for (const row of page.records) {
      entries.push({
        kind,
        name: str(row.Name),
        status: str(row.Status) === 'Inactive' ? 'Inactive' : 'Active',
        ...(kind === 'trigger' && str(row.TableEnumOrId) ? { object: str(row.TableEnumOrId) } : {}),
      });
    }
  }
  return { where: whereOf(access), entries };
}

// ——— pull ———

export interface PulledApex extends ApexUnit {
  path: string;
  object?: string;
  apiVersion: string;
  status: ApexStatus;
  state: 'new' | 'same' | 'replaced';
}

export interface Retrieved {
  where: string;
  pulled: PulledApex[];
  problems: string[];
  /** sfdx-project.json was written: the repository had none. */
  wroteProject: boolean;
}

/** Pull classes and triggers from an org into the checkout, in the Salesforce DX layout. */
export async function retrieveApex(
  checkout: ApexCheckout,
  caller: ApexCaller,
  input: { org?: string; names: string[]; kinds?: ApexKind[] }
): Promise<Retrieved | ApexFailure> {
  if (input.names.length === 0) return { error: 'Name at least one class or trigger to pull.' };
  const kinds = input.kinds ?? ['class', 'trigger'];
  const access = await apexAccess(caller, RETRIEVE_TOOL, input.org);
  if (failed(access)) return access;
  const located = await sourceRoot(checkout);
  if (failed(located)) return located;
  const pulled: PulledApex[] = [];
  const problems: string[] = [];
  for (const name of input.names) {
    const live = await findLive(caller, access, name, kinds);
    if (typeof live === 'string') {
      problems.push(`${name}: ${live}`);
      continue;
    }
    if (!live) {
      problems.push(
        `${name}: ${whereOf(access)} has no Apex ${kinds.length === 1 ? kinds[0] : 'class or trigger'} of its own by that name.${await suggestionsFor(caller, access, name)}`
      );
      continue;
    }
    const path = apexSourcePath(live, located.root);
    const before = await readRepoFile(checkout, path);
    if (failed(before)) return before;
    for (const [file, content] of [
      [path, live.body],
      [`${path}-meta.xml`, apexMetaXml(live.kind, live.apiVersion, live.status)],
    ] as const) {
      const written = await sbWorkspaceWrite(checkout.target, {
        id: checkout.workspaceId,
        path: file,
        content,
      });
      if (!written.ok) return sandboxFailure(written.err);
    }
    pulled.push({
      kind: live.kind,
      name: live.name,
      path,
      ...(live.object ? { object: live.object } : {}),
      apiVersion: live.apiVersion,
      status: live.status,
      state: before === null ? 'new' : before === live.body ? 'same' : 'replaced',
    });
  }
  let wroteProject = false;
  if (!located.hasProject && pulled.length > 0) {
    const project = {
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: SALESFORCE_API_VERSION,
    };
    const written = await sbWorkspaceWrite(checkout.target, {
      id: checkout.workspaceId,
      path: 'sfdx-project.json',
      content: `${JSON.stringify(project, null, 2)}\n`,
    });
    if (!written.ok) return sandboxFailure(written.err);
    wroteProject = true;
  }
  return { where: whereOf(access), pulled, problems, wroteProject };
}

// ——— tests ———

export interface StartedTests {
  where: string;
  deployId: string;
  sent: { name: string; kind: ApexKind; addedTest: boolean }[];
  /** What the run's coverage is measured against. */
  measured: ApexUnit[];
}

/** Send the repository's Apex to an org as a validation that runs the named tests; nothing changes. */
export async function startApexTests(
  checkout: ApexCheckout,
  caller: ApexCaller,
  input: { org?: string; tests: string[]; names: string[] }
): Promise<StartedTests | ApexFailure> {
  if (input.tests.length === 0) return { error: 'Name the test classes to run.' };
  const access = await apexAccess(caller, TEST_TOOL, input.org);
  if (failed(access)) return access;
  const located = await sourceRoot(checkout);
  if (failed(located)) return located;
  const selection = await selectApex(
    checkout,
    caller,
    access,
    located.root,
    input.names,
    input.tests
  );
  if (failed(selection)) return selection;
  if (selection.upserts.length === 0) {
    return {
      error:
        'Nothing to send: no Apex is changed and not committed. Name the classes and triggers to test.',
    };
  }
  const built = apexPackage({ upserts: selection.upserts.map(toUpsert) });
  const started = await startDeploy({ subject: caller.subject }, access, built.files, {
    checkOnly: true,
    tests: input.tests,
  });
  if (!started.ok) return { error: `Salesforce would not start the run: ${started.error}` };
  return {
    where: whereOf(access),
    deployId: started.outcome.id,
    sent: selection.upserts.map((unit) => ({
      name: unit.name,
      kind: unit.kind,
      addedTest: selection.addedTests.includes(unit.name),
    })),
    measured: measuredOf(selection.upserts),
  };
}

export interface TestReport {
  where: string;
  deployId: string;
  done: boolean;
  /** Salesforce's word for where the run is: InProgress, Succeeded, Failed… */
  status: string;
  /** Compile and deploy errors, one line each. */
  compile: string[];
  run: ApexTestRun | null;
  coverage: { unit: ApexUnit; percent: number }[];
  /** Why it would not deploy. */
  problems: string[];
  errorMessage: string | null;
  /** Every test passed, it compiled, and each measured class is covered enough: it would deploy. */
  ok: boolean;
}

/** How a run's tests ended, against what it is measured by (default: everything it covered). */
export function testReportOf(
  where: string,
  outcome: DeployOutcome,
  measured: readonly ApexUnit[] | null
): TestReport {
  const compileFailures = outcome.failures.filter((f) => f.type !== '' || f.name !== '');
  const compile =
    compileFailures.length > 0
      ? failureLines({ ...outcome, failures: compileFailures, errorMessage: undefined })
      : [];
  const run = outcome.tests ?? null;
  const against =
    measured ??
    (run?.coverage ?? []).map((entry) => ({
      kind: entry.type.toLowerCase() === 'trigger' ? ('trigger' as const) : ('class' as const),
      name: entry.name,
    }));
  const verdict = apexTestVerdict(run ?? undefined, against);
  const ok = outcome.done && verdict.ok && compile.length === 0 && outcome.success;
  return {
    where,
    deployId: outcome.id,
    done: outcome.done,
    status: outcome.status,
    compile,
    run,
    coverage: verdict.covered,
    problems: verdict.ok ? [] : verdict.problems,
    errorMessage: outcome.errorMessage && compile.length === 0 ? outcome.errorMessage : null,
    ok,
  };
}

/** A run's state, waiting up to `waitMs` for it to end. */
export async function apexTestStatus(
  caller: ApexCaller,
  input: { org?: string; deployId: string; measured: ApexUnit[] | null; waitMs: number }
): Promise<TestReport | ApexFailure> {
  const access = await apexAccess(caller, TEST_TOOL, input.org);
  if (failed(access)) return access;
  const waited = await waitForDeploy(
    { subject: caller.subject },
    access,
    input.deployId,
    input.waitMs
  );
  if (!waited.ok) return { error: `Could not read the run ${input.deployId}: ${waited.error}` };
  return testReportOf(whereOf(access), waited.outcome, input.measured);
}

// ——— propose ———

export interface ApexProposal {
  changeId: string;
  url: string;
  validation: Validation;
  text: string;
  title: string;
}

/** Make the repository's Apex a change request: diffs, preconditions, tests, validated by Salesforce. */
export async function proposeApex(
  checkout: ApexCheckout,
  caller: ApexCaller,
  input: {
    org?: string;
    tests: string[];
    names: string[];
    deactivateTriggers: string[];
    deleteClasses: string[];
    title?: string;
    reason?: string;
    replaces?: string;
  }
): Promise<ApexProposal | ApexFailure> {
  const access = await apexAccess(caller, PROPOSE_TOOL, input.org);
  if (failed(access)) return access;
  const refused = await refusesChanges(access);
  if (refused) return { error: refused };
  const { tests, deactivateTriggers: deactivate, deleteClasses: deletes } = input;
  if (tests.length === 0) {
    return { error: 'Name the test classes every validation and deploy of this runs.' };
  }
  const located = await sourceRoot(checkout);
  if (failed(located)) return located;
  // With only switches-off or deletes asked for, nothing else is sent by default.
  const onlyRemovals = input.names.length === 0 && (deactivate.length > 0 || deletes.length > 0);
  const selected = await selectApex(checkout, caller, access, located.root, input.names, tests);
  if (failed(selected)) return selected;
  const selection = onlyRemovals
    ? { ...selected, upserts: selected.upserts.filter((u) => selected.addedTests.includes(u.name)) }
    : selected;
  const where = whereOf(access);
  const ctx = { subject: caller.subject };

  const upserts: ApexUpsert[] = [];
  const components: ComponentView[] = [];
  const preconditions: Precondition[] = [];
  const summary: string[] = [];
  const skipped: string[] = [];
  for (const unit of selection.upserts) {
    const live = await readLiveApex(ctx, access, unit);
    if (typeof live === 'string')
      return { error: `Could not read ${unit.name} in ${where}: ${live}` };
    if (live && live.body === unit.body && live.status === unit.status) {
      skipped.push(unit.name);
      continue;
    }
    if (live && live.kind !== unit.kind) {
      return { error: `${unit.name} is a ${live.kind} in ${where} but a ${unit.kind} here.` };
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
    summary.push(`• ${live ? 'Change' : 'New'} ${unit.kind} ${unit.name} (+${added} −${removed})`);
  }
  for (const name of deactivate) {
    const live = await readLiveApex(ctx, access, { kind: 'trigger', name });
    if (typeof live === 'string') return { error: `Could not read the trigger ${name}: ${live}` };
    if (!live) return { error: `${where} has no trigger ${name} to switch off.` };
    if (upserts.some((u) => u.kind === 'trigger' && u.name === name)) {
      return { error: `${name} is both written and switched off; do one.` };
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
    summary.push(`• Switch off the trigger ${name}${live.object ? ` on ${live.object}` : ''}`);
  }
  const deleted: ApexUnit[] = [];
  for (const name of deletes) {
    const live = await readLiveApex(ctx, access, { kind: 'class', name });
    if (typeof live === 'string') return { error: `Could not read the class ${name}: ${live}` };
    if (!live) return { error: `${where} has no class ${name} to delete.` };
    if (upserts.some((u) => u.kind === 'class' && u.name === name)) {
      return { error: `${name} is both written and deleted; do one.` };
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
    return {
      error: `Nothing to propose: ${
        skipped.length > 0
          ? `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} already as ${where} has ${skipped.length === 1 ? 'it' : 'them'}.`
          : 'no Apex is changed and not committed; name what to send.'
      }`,
    };
  }
  const built = apexPackage({ upserts, deletes: deleted });
  const switchedOff = (u: ApexUpsert) =>
    u.kind === 'trigger' && u.status === 'Inactive' && deactivate.includes(u.name);
  const what = [
    ...upserts.map((u) => (switchedOff(u) ? `${u.name} off` : u.name)),
    ...deleted.map((u) => `${u.name} deleted`),
  ];
  const title = input.title?.trim()
    ? input.title.trim()
    : `Apex: ${what.slice(0, 4).join(', ')}${what.length > 4 ? ` and ${what.length - 4} more` : ''}`;
  const proposed = await proposeChange(
    { subject: caller.subject, ...(caller.origin ? { origin: caller.origin } : {}) },
    access,
    {
      kind: APEX_KIND,
      title,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
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
  if (typeof proposed === 'string') return { error: proposed };
  return { ...proposed, title };
}

export { APEX_COVERAGE_PERCENT };
