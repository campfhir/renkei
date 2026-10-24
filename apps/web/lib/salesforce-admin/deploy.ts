/**
 * Deploying a change request's files through the Metadata API's REST
 * resource (`/metadata/deployRequest`, docs/salesforce-metadata-api-developer-guide.pdf,
 * "Deploy Metadata with Apex Testing Using REST"), on the person's own
 * admin grant through the delegate.
 *
 * - `startDeploy` zips the files and POSTs them as `multipart/form-data`:
 *   a `json` part with the deployOptions and a `file` part with the zip.
 *   Always transactional (`rollbackOnError`, which production requires
 *   anyway), one package (`singlePackage`). With `checkOnly` it is the
 *   proposal's validation: Salesforce compiles and checks everything and
 *   changes nothing.
 * - `quickDeploy` deploys a validation that qualifies without running it
 *   again (`POST …/deployRequest/{validatedId}`); Salesforce answers 404
 *   when it does not qualify, and the caller then deploys in full.
 * - `deployStatus` reads one with its component results, and `waitForDeploy`
 *   polls it within a budget — the deploy itself carries on in Salesforce
 *   past that, and a later look picks it up.
 *
 * Tests: sandboxes run none (`NoTestRun`); production is left to
 * Salesforce's default, which runs none for a package without Apex — the
 * only kind these proposals build.
 */

import JSZip from 'jszip';
import { dataPath, parseDeployResult, type DeployOutcome } from '@renkei/connector-salesforce';
import { refusalTextOf } from '@/lib/grant-refusals';
import { logger, secure } from '@/lib/logger';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '@/lib/mcp-tools/fetch-guard';
import {
  describeErrors,
  rec,
  sfGet,
  sfRequest,
  type SalesforceAccess,
  type SalesforceCallContext,
  type SalesforceError,
} from '@/lib/mcp-tools/salesforce/client';

export type DeployAnswer = { ok: true; outcome: DeployOutcome } | { ok: false; error: string };

/** The deployment's files as a zip, paths as given (`package.xml`, `objects/…`). */
export async function zipFiles(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * The deployRequest body, written by hand: Salesforce wants the `json` part
 * as a bare `form-data; name="json"` with its own content type, and
 * FormData always stamps a `filename` on a Blob part, which Salesforce
 * refuses as INVALID_MULTIPART_REQUEST.
 */
export function deployMultipart(
  json: unknown,
  zip: Uint8Array
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `renkei-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\nContent-Type: application/json\r\n\r\n` +
      `${JSON.stringify(json)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deploy.zip"\r\nContent-Type: application/zip\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + zip.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(zip, head.byteLength);
  body.set(tail, head.byteLength + zip.byteLength);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function errorsOf(body: unknown): SalesforceError[] {
  return (Array.isArray(body) ? body : [body]).flatMap((item: unknown) => {
    const entry = rec(item);
    return typeof entry.message === 'string'
      ? [
          {
            message: entry.message,
            errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : '',
            fields: [],
          },
        ]
      : [];
  });
}

/** Start a deploy (or, with `checkOnly`, a validation) of these files. */
export async function startDeploy(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  files: Record<string, string>,
  options: { checkOnly: boolean }
): Promise<DeployAnswer> {
  const zip = await zipFiles(files);
  const deployOptions = {
    checkOnly: options.checkOnly,
    rollbackOnError: true,
    singlePackage: true,
    ignoreWarnings: false,
    allowMissingFiles: false,
    ...(access.sandbox ? { testLevel: 'NoTestRun' } : {}),
  };
  const { body, contentType } = deployMultipart({ deployOptions }, zip);

  let response: Response;
  try {
    response = await access.auth(`${access.instanceUrl}${dataPath('/metadata/deployRequest')}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': contentType },
      body,
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const host = new URL(access.instanceUrl).hostname;
    return {
      ok: false,
      error: isTimeoutError(error)
        ? `${host} timed out starting the deploy; look in Setup → Deployment Status before trying again.`
        : `Could not reach ${host}`,
    };
  }
  const refused = refusalTextOf(response, 'Salesforce Admin');
  if (refused) return { ok: false, error: refused };
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // The status decides.
  }
  if (!response.ok) {
    logger.warn('Salesforce deployRequest refused', {
      component: 'salesforce-admin/deploy',
      subject: context.subject,
      status: response.status,
      checkOnly: options.checkOnly,
      responseBody: text ? secure(text.slice(0, 2000)) : undefined,
    });
    const errors = errorsOf(parsed);
    return {
      ok: false,
      error: errors.length
        ? describeErrors(errors)
        : `Salesforce refused the deploy (HTTP ${response.status}).`,
    };
  }
  return { ok: true, outcome: parseDeployResult(parsed) };
}

/** A deploy's state with its component results. */
export async function deployStatus(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  deployId: string
): Promise<DeployAnswer> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(deployId)) return { ok: false, error: 'Not a deploy id.' };
  const result = await sfGet(
    context,
    access,
    `/metadata/deployRequest/${encodeURIComponent(deployId)}?includeDetails=true`
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, outcome: parseDeployResult(result.body) };
}

/**
 * Deploy a passed validation without running it again. `null` when
 * Salesforce says it does not qualify (404, or INVALID_ID_FIELD for a
 * validation that ran no tests) — deploy in full instead.
 */
export async function quickDeploy(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  validatedId: string
): Promise<DeployAnswer | null> {
  const result = await sfRequest(
    context,
    access,
    'POST',
    `/metadata/deployRequest/${encodeURIComponent(validatedId)}`,
    { validatedDeployRequestId: validatedId }
  );
  if (!result.ok) {
    // Not qualifying comes back as a 404, or as INVALID_ID_FIELD ("Source
    // validate did not run tests in the org") — the case for every
    // production validation here, since a package without Apex runs none.
    const doesNotQualify =
      result.status === 404 ||
      result.errors.some((error) => error.errorCode === 'INVALID_ID_FIELD');
    return doesNotQualify ? null : { ok: false, error: result.error };
  }
  return { ok: true, outcome: parseDeployResult(result.body) };
}

/**
 * Poll a deploy until it is done or the budget runs out; the last answer
 * either way (a deploy still running is not a failure).
 */
export async function waitForDeploy(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  deployId: string,
  budgetMs: number,
  pollMs = 2_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<DeployAnswer> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await deployStatus(context, access, deployId);
    if (!status.ok || status.outcome.done || Date.now() + pollMs > deadline) return status;
    await sleep(pollMs);
  }
}

/** Salesforce's component errors, one line each, for the model and the review page. */
export function failureLines(outcome: DeployOutcome): string[] {
  const lines = outcome.failures.map(
    (failure) =>
      `${failure.type ? `${failure.type} ` : ''}${failure.name}: ${failure.problem}${failure.line ? ` (line ${failure.line})` : ''}`
  );
  if (outcome.errorMessage) lines.push(outcome.errorMessage);
  return lines;
}
