/**
 * code_salesforce_pull: how a chat in a code project brings what a
 * Salesforce org holds into the repository, as source — the first half of
 * "changes to Salesforce go through the project's pipeline"
 * (docs/salesforce-ci-design.md). A local tool bound to ONE checkout, like
 * the rest of the code_* set (tools.ts).
 *
 * Three steps, and no Salesforce credential in any of them leaves the
 * delegate:
 *
 *   1. The Metadata API's retrieve, on the chatting person's own Salesforce
 *      Admin connection. The delegate holds the token and writes the SOAP
 *      envelope (apps/worker-delegate/src/salesforce-soap.ts); this sends
 *      only which types and members.
 *   2. The zip Salesforce answers with goes into the checkout as a file.
 *   3. The Salesforce CLI in the sandbox turns it into source format
 *      (`sf project convert mdapi`), offline — it is signed in to nothing —
 *      and the zip is removed.
 *
 * What it leaves is uncommitted changes in the chat's worktree: the model
 * reads them, commits on its branch and opens a pull request like any other
 * change. Nothing here writes to an org.
 */

import {
  SALESFORCE_API_VERSION,
  checkRetrieveBody,
  readRetrieveSelection,
  readRetrieveStarted,
  readRetrieveStatus,
  retrieveBody,
  type RetrieveSelection,
} from '@renkei/connector-salesforce';
import { clipOutput } from '@renkei/connector-sandbox';
import {
  sbWorkspaceExec,
  sbWorkspaceUpload,
  type SandboxClientError,
  type SandboxTarget,
} from '@renkei/sandbox-client';
import type { McpToolResult } from '@renkei/mcp-client';
import { recordAuditEvent } from '@/lib/audit-events';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import { refusalTextOf } from '@/lib/grant-refusals';
import { resolveSalesforceAccess, type SalesforceAccess } from '@/lib/mcp-tools/salesforce/client';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';

export interface SalesforcePullDeps {
  target: SandboxTarget;
  /** The checkout the tool works in, read at call time (a recovery moves it). */
  ref: { id: string };
  repoFullName: string;
  failed: (error: SandboxClientError) => McpToolResult;
  /** Between two looks at a retrieve; a test passes none. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const SALESFORCE_PULL_TOOL = 'code_salesforce_pull';

/** Reading an org's metadata is what the admin connector's read capability allows. */
const PULL_SCOPES = ['sfa-read'];
const SOAP_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
/** How long Salesforce gets to assemble the zip before the tool says to ask for less. */
const RETRIEVE_WAIT_MS = 5 * 60_000;
/** The Metadata API's own ceiling for a retrieve, unzipped, is 400 MB; a zip past this is not a pull to review. */
const MAX_ZIP_BYTES = 64 * 1_048_576;
const CONVERT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_MAX_CHARS = 12_000;
export const SALESFORCE_PULL_TIMEOUT_MS = RETRIEVE_WAIT_MS + CONVERT_TIMEOUT_MS + 60_000;

const ZIP_PATH = '.renkei-salesforce-pull.zip';

/**
 * Unpacks the zip outside the checkout, converts it into the project's
 * default package directory, and leaves neither the zip nor the unpacked
 * copy behind however it ends. A repository that is not a Salesforce DX
 * project yet becomes one, and a package directory the project names but
 * does not have yet is made.
 */
const CONVERT = [
  'set -e',
  // The Salesforce CLI asks the system for its user's shell when SHELL is
  // not exported, and a caller's uid has no passwd entry to answer with. The
  // sandbox worker exports it now (childEnvironment); a sandbox still running
  // an earlier build does not, so the command says it for itself.
  'export SHELL=/bin/sh',
  `zip=${ZIP_PATH}`,
  // Unpacked outside the checkout, and not under a dot directory: once a
  // project has a .forceignore the CLI also ignores every dot path beneath
  // it, and a copy unpacked there converts to nothing.
  'dir=$(mktemp -d)',
  'trap \'rm -rf "$zip" "$dir"\' EXIT',
  'if ! command -v sf >/dev/null 2>&1; then',
  "  echo 'This sandbox has no Salesforce CLI (sf), so the pull could not be turned into source.' >&2",
  '  exit 1',
  'fi',
  'unzip -q -o "$zip" -d "$dir"',
  'manifest=$(find "$dir" -name package.xml | head -n 1)',
  'if [ -z "$manifest" ]; then',
  "  echo 'What Salesforce sent holds no package.xml.' >&2",
  '  exit 1',
  'fi',
  'if [ ! -f sfdx-project.json ]; then',
  '  printf \'%s\\n\' \'{\' \'  "packageDirectories": [{ "path": "force-app", "default": true }],\' \'  "namespace": "",\' \'  "sfdcLoginUrl": "https://login.salesforce.com",\' \'  "sourceApiVersion": "' +
    SALESFORCE_API_VERSION +
    "\"' '}' > sfdx-project.json",
  "  echo 'Started a Salesforce DX project here: sfdx-project.json and force-app/.'",
  'fi',
  // The CLI refuses a project whose package directory is not there yet, as in
  // one that has only its sfdx-project.json. A file it cannot read is the
  // CLI's to report, in its own words.
  'node -e \'for (const d of JSON.parse(require("fs").readFileSync("sfdx-project.json", "utf8")).packageDirectories || []) if (typeof d.path === "string" && d.path) console.log(d.path)\' 2>/dev/null | while IFS= read -r package_dir; do',
  '  mkdir -p -- "$package_dir"',
  'done',
  'sf project convert mdapi --root-dir "$(dirname "$manifest")" 2>&1',
  // Gone before the status below, so it lists only what the pull changed.
  'rm -rf "$zip" "$dir"',
  "echo '--- git status'",
  'git status --short | head -n 200',
].join('\n');

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** One of the delegate's Metadata API reads; the answer's text, or why there is none. */
async function soap(
  access: SalesforceAccess,
  body: string,
  signal: AbortSignal | undefined
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const timeout = AbortSignal.timeout(SOAP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await access.auth(
      `${access.instanceUrl}/services/Soap/m/${SALESFORCE_API_VERSION}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
        body,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      }
    );
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach Salesforce: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const refused = refusalTextOf(response, SALESFORCE_ADMIN_KIND.label);
  if (refused) return { ok: false, error: refused };
  return { ok: true, text: await response.text().catch(() => '') };
}

type Pulled =
  | {
      ok: true;
      zip: Buffer<ArrayBuffer>;
      components: { type: string; fullName: string }[];
      problems: string[];
    }
  | { ok: false; error: string };

/** Starts the retrieve and waits for its zip. */
async function retrieve(
  access: SalesforceAccess,
  types: RetrieveSelection[],
  wait: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined
): Promise<Pulled> {
  const started = await soap(access, retrieveBody(types), signal);
  if (!started.ok) return started;
  const id = readRetrieveStarted(started.text);
  if ('fault' in id)
    return { ok: false, error: `Salesforce would not start the pull: ${id.fault}` };
  for (let waited = 0; waited < RETRIEVE_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS, signal);
    if (signal?.aborted) return { ok: false, error: 'The pull was stopped.' };
    const answer = await soap(access, checkRetrieveBody(id.id), signal);
    if (!answer.ok) return answer;
    const status = readRetrieveStatus(answer.text);
    if ('fault' in status)
      return {
        ok: false,
        error: `Salesforce would not say how the pull is doing: ${status.fault}`,
      };
    if (!status.done) continue;
    if (status.error) {
      return {
        ok: false,
        error: [`Salesforce could not pull that: ${status.error}`, ...status.problems].join('\n'),
      };
    }
    const zip = Buffer.from(status.zip, 'base64');
    if (zip.byteLength === 0) return { ok: false, error: 'Salesforce answered with an empty zip.' };
    if (zip.byteLength > MAX_ZIP_BYTES) {
      return {
        ok: false,
        error: `That is ${Math.round(zip.byteLength / 1_048_576)} MB zipped, more than one pull takes; ask for fewer types or members at a time.`,
      };
    }
    return { ok: true, zip, components: status.components, problems: status.problems };
  }
  return {
    ok: false,
    error:
      'Salesforce was still assembling the pull after five minutes; ask for fewer types or members at a time.',
  };
}

/**
 * Whether the person has connected a Salesforce Admin connector the
 * organization still has: what puts the code_salesforce_* tools in a code
 * project's turn (turn.ts). Anything that cannot be read is a no.
 */
export async function hasSalesforceAdminConnection(subject: string): Promise<boolean> {
  try {
    const connectors = await listSalesforceConnectors(SALESFORCE_ADMIN_KIND);
    if (connectors.length === 0) return false;
    const connections = await listSalesforceConnections(
      subject,
      connectors,
      SALESFORCE_ADMIN_KIND.provider
    );
    return connections.some((connection) => connection.connector !== null);
  } catch {
    return false;
  }
}

/** How many of each type came back, most first: `CustomObject 3, ApexClass 2`. */
export function countByType(components: readonly { type: string }[]): string {
  const counts = new Map<string, number>();
  for (const { type } of components) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
}

export function salesforcePullTools(deps: SalesforcePullDeps): LocalTool[] {
  const wait = deps.wait ?? sleep;
  return [
    {
      def: {
        name: SALESFORCE_PULL_TOOL,
        description:
          'Pull metadata from one of the organization’s Salesforce orgs into this checkout as Salesforce DX source (under the project’s package directory, force-app by default), using your Salesforce Admin connection: custom objects and fields, layouts, Apex classes and triggers, Lightning web components, permission sets, reports, and any other metadata type by its Metadata API name. It only reads the org and writes files here, uncommitted; look at what changed, commit it on your branch and open a pull request. Use it to bring an existing org into the repository, or to bring in what someone changed in the org by hand. Changes go to an org only through the project’s pipeline, never from here.',
        inputSchema: {
          type: 'object',
          properties: {
            org: {
              type: 'string',
              maxLength: 200,
              description:
                'The org to read, by the name or key salesforce_admin_list_orgs gives. Omit when you are connected to only one.',
            },
            components: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              description: 'What to pull: each entry a metadata type and the members of it wanted.',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    description:
                      'A Metadata API type name: CustomObject, ApexClass, ApexTrigger, LightningComponentBundle, Layout, FlexiPage, PermissionSet, Report, …',
                  },
                  members: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                    description:
                      'Full names (Account, Visit__c, AccountService, a report as Folder/Report_Name), or * for every one of a type that takes it. A standard object is always named, never *.',
                  },
                },
                required: ['type', 'members'],
                additionalProperties: false,
              },
            },
          },
          required: ['components'],
          additionalProperties: false,
        },
      },
      timeoutMs: SALESFORCE_PULL_TIMEOUT_MS,
      async execute(input, context) {
        if (context.readOnly) {
          return errorResult('The organization is in read-only mode, so nothing is written here.');
        }
        const selection = readRetrieveSelection(input.components);
        if (!selection.ok) return errorResult(selection.error);
        const org =
          typeof input.org === 'string' && input.org.trim() ? input.org.trim() : undefined;
        const access = await orgCall.run({ org, tool: SALESFORCE_PULL_TOOL }, () =>
          resolveSalesforceAccess(
            {
              subject: context.subject,
              ...(context.userEmail ? { userEmail: context.userEmail } : {}),
            },
            SALESFORCE_ADMIN_KIND,
            () => PULL_SCOPES
          )
        );
        if (typeof access === 'string') return errorResult(access);

        const pulled = await retrieve(access, selection.types, wait, context.signal);
        if (!pulled.ok) return errorResult(pulled.error);

        const uploaded = await sbWorkspaceUpload(deps.target, {
          id: deps.ref.id,
          path: ZIP_PATH,
          bytes: new Uint8Array(pulled.zip),
        });
        if (!uploaded.ok) return deps.failed(uploaded.err);
        const converted = await sbWorkspaceExec(
          deps.target,
          { id: deps.ref.id, command: CONVERT, timeoutMs: CONVERT_TIMEOUT_MS },
          context.signal ? { signal: context.signal } : {}
        );
        if (!converted.ok) return deps.failed(converted.err);
        const output = clipOutput(
          [converted.val.stdout.trim(), converted.val.stderr.trim()].filter(Boolean).join('\n'),
          OUTPUT_MAX_CHARS
        ).text;
        if (converted.val.exitCode !== 0) {
          return errorResult(
            `Salesforce sent ${pulled.components.length} component(s) from ${access.connectorName}, but turning them into source failed${converted.val.timedOut ? ' (it ran out of time)' : ''}; the checkout’s own files are as they were unless the output below says otherwise.\n\n${output}`
          );
        }

        recordAuditEvent({
          actorSubject: context.subject,
          action: 'code.salesforce.pulled',
          targetKind: 'code_project',
          targetLabel: deps.repoFullName,
          details: {
            projectId: context.projectId,
            repository: deps.repoFullName,
            org: access.connector,
            orgName: access.connectorName,
            types: selection.types.map(({ type, members }) => ({ type, members: members.length })),
            components: pulled.components.length,
            via: 'chat',
          },
        });
        return textResult(
          [
            `Pulled ${pulled.components.length} component(s) from ${access.connectorName}${access.sandbox ? ' (a sandbox)' : ''} into this checkout as source: ${countByType(pulled.components) || 'none'}.`,
            ...(pulled.problems.length > 0
              ? [
                  'Salesforce could not give some of what was asked:',
                  ...pulled.problems.slice(0, 20).map((problem) => `- ${problem}`),
                ]
              : []),
            '',
            output,
            '',
            'Nothing is committed. Read what changed, commit it on your branch, and open a pull request; the org changes only when the project’s pipeline deploys a merge.',
          ].join('\n')
        );
      },
    },
  ];
}
