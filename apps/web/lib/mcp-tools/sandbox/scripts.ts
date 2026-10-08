/**
 * sandbox_run_python — a Python script the model wrote, run by the sandbox
 * worker over copies of the caller's own staged files, as the caller's
 * own unprivileged uid, with no network, a memory and time ceiling, in a
 * directory that exists for the run and no longer (apps/worker-sandbox/
 * src/scripts.ts). Whatever it writes under `out/` is staged back under
 * the same quota as any other file and answered by id, so the model
 * can send it on with sandbox_send_to_upload exactly as it would a
 * rendered document.
 *
 * This is the data-level step the text tools cannot be: matching two
 * spreadsheets by a key column, filtering thousands of rows, totalling
 * a column — work where retyping values from a text dump silently puts
 * the wrong value on the wrong row. The script does the matching; the
 * model only ever sees what it prints and what it names.
 *
 * Registered only where the deployment runs scripts
 * (SANDBOX_SCRIPTS_ENABLED on the worker and here) — closed, never open.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  SCRIPT_CODE_MAX_CHARS,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_INPUT_DIR,
  SCRIPT_MAX_INPUT_FILES,
  SCRIPT_MAX_OUTPUT_FILES,
  SCRIPT_MAX_TIMEOUT_MS,
  SCRIPT_OUTPUT_DEFAULT_CHARS,
  SCRIPT_OUTPUT_DIR,
  SCRIPT_OUTPUT_MAX_CHARS,
  clipOutput,
} from '@renkei/connector-sandbox';
import type { MCPToolContext } from '../common';
import { errText, fileLine, str, targetOf, textResult } from './shared';
import { sbRunScript, clientFailure, type WireScriptResult } from '@/lib/sandbox/service-client';

/** What the model reads back: the exit, the streams clipped to budget, and what came out. */
export function renderScriptRun(
  result: WireScriptResult,
  maxChars: number
): { text: string; ok: boolean } {
  const head = result.interrupted
    ? 'INTERRUPTED — the sandbox worker was stopped (a restart or a deploy) while this script ran, and killed it; it did not finish. Run it again.'
    : result.timedOut
      ? `TIMED OUT after ${Math.round(result.timeoutMs / 1000)}s — the process tree was killed; pass a larger timeoutSeconds if the work needs it`
      : result.exitCode === null
        ? `killed by ${result.signal ?? 'a signal'}${result.signal === 'SIGKILL' ? ' (most often the memory ceiling: process less at once)' : ''}`
        : `exit ${result.exitCode}`;
  const notes: string[] = [];
  if (result.truncated) notes.push('output exceeded the worker’s buffer and was cut');
  if (!result.networkIsolated)
    notes.push('this worker could not isolate the network, so the script had the container’s');
  if (!result.uidIsolated) notes.push('this worker is unprivileged, so the script ran as its user');
  const stdout = clipOutput(result.stdout.replace(/\s+$/, ''), Math.floor(maxChars * 0.7));
  const stderr = clipOutput(result.stderr.replace(/\s+$/, ''), maxChars - stdout.text.length);
  const parts = [`${head} (${(result.durationMs / 1000).toFixed(1)}s)`];
  if (notes.length) parts.push(`[${notes.join('; ')}]`);
  if (result.inputs.length) {
    parts.push(
      `--- inputs ---\n${result.inputs.map((input) => `${input.path} — ${input.sizeBytes} bytes (${input.id})`).join('\n')}`
    );
  }
  parts.push(`--- stdout ---\n${stdout.text || '(none)'}`);
  parts.push(`--- stderr ---\n${stderr.text || '(none)'}`);
  if (result.outputs.length) {
    parts.push(
      `--- staged from ${SCRIPT_OUTPUT_DIR}/ ---\n${result.outputs.map((file) => `Staged ${fileLine(file)}`).join('\n')}`
    );
  }
  if (result.skippedOutputs.length) {
    parts.push(
      `--- not staged ---\n${result.skippedOutputs.map((entry) => `${entry.filename}: ${entry.reason}`).join('\n')}`
    );
  }
  return {
    text: parts.join('\n'),
    ok: result.exitCode === 0 && !result.timedOut && !result.interrupted,
  };
}

export function registerSandboxScriptTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sandbox_run_python',
    {
      title: 'Sandbox · Act — Run a Python script over your staged files',
      description:
        'Run Python you write over the files in your scratch space, on the sandbox worker — ' +
        'for anything at the data level a text dump cannot do reliably: match two spreadsheets ' +
        'by a key column (an MRN, an id), filter or de-duplicate thousands of rows, total or ' +
        'pivot a column, convert between formats, check a file’s structure before you use it. ' +
        'Prefer this over reading a large spreadsheet with sandbox_read_file and retyping ' +
        'values: the script does the matching, and the wrong value cannot land on the wrong row. ' +
        `The script starts in an empty directory with your staged files copied read-only under ` +
        `${SCRIPT_INPUT_DIR}/ by their filenames (a repeated name gets “ (2)” before its extension; ` +
        `the result lists each path) and an empty ${SCRIPT_OUTPUT_DIR}/ directory: every regular ` +
        `file it leaves directly in ${SCRIPT_OUTPUT_DIR}/ is staged back into your scratch space ` +
        'and answered by id, ready for sandbox_send_to_upload or sandbox_read_file. Print what ' +
        'you want to see; stdout and stderr come back (up to maxChars, the middle of long output ' +
        'omitted), so print a summary and a sample rather than every row. ' +
        'pandas, numpy, openpyxl (read and write .xlsx) and XlsxWriter are installed; the ' +
        'standard library beyond that. There is NO network (no pip, no HTTP), no access to ' +
        'anything but the run’s own directory, a memory ceiling, and the run is killed at ' +
        `timeoutSeconds (default ${SCRIPT_DEFAULT_TIMEOUT_MS / 1000}, max ${SCRIPT_MAX_TIMEOUT_MS / 1000}) — ` +
        'say so for a long job. Pass files to choose which staged files to copy in (by id, ' +
        `from sandbox_list_files, up to ${SCRIPT_MAX_INPUT_FILES}); omit it for all of them. ` +
        `At most ${SCRIPT_MAX_OUTPUT_FILES} output files, each under the staged-file size cap; ` +
        'anything not staged is listed with why. Nothing persists between runs except what ' +
        'you staged — a second run starts clean.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .max(SCRIPT_CODE_MAX_CHARS)
          .describe(
            `The Python 3 script, complete, as text (at most ${SCRIPT_CODE_MAX_CHARS} characters). Read inputs from ${SCRIPT_INPUT_DIR}/<filename>, write results into ${SCRIPT_OUTPUT_DIR}/.`
          ),
        files: z
          .array(z.string().uuid())
          .max(SCRIPT_MAX_INPUT_FILES)
          .optional()
          .describe(
            'Staged file ids to copy in (from sandbox_list_files or a stage tool). Omit for every file you have staged.'
          ),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(SCRIPT_MAX_TIMEOUT_MS / 1000)
          .optional()
          .describe(`Wall-clock limit for the run (default ${SCRIPT_DEFAULT_TIMEOUT_MS / 1000}).`),
        maxChars: z
          .number()
          .int()
          .min(200)
          .max(SCRIPT_OUTPUT_MAX_CHARS)
          .optional()
          .describe(`Cap on returned output characters (default ${SCRIPT_OUTPUT_DEFAULT_CHARS}).`),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const code = str(args.code);
      if (!code.trim()) return errText('A script is required.');
      const files = Array.isArray(args.files)
        ? args.files.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
      const timeoutSeconds =
        typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined;
      const maxChars =
        typeof args.maxChars === 'number'
          ? Math.min(SCRIPT_OUTPUT_MAX_CHARS, Math.max(200, Math.floor(args.maxChars)))
          : SCRIPT_OUTPUT_DEFAULT_CHARS;
      // The worker kills the script when this call goes away, so a client
      // that gives up on the request takes the run with it rather than
      // leaving it to its timeout.
      const ran = await sbRunScript(target, {
        code,
        ...(files && files.length ? { files } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
      });
      if (!ran.ok) return errText(clientFailure(ran.err).message);
      const rendered = renderScriptRun(ran.val, maxChars);
      return rendered.ok ? textResult(rendered.text) : errText(rendered.text);
    }
  );
}
