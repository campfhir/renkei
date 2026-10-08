/**
 * The HTTP verb for scripts over staged files — dispatched from
 * server.ts under `/v1/scripts/*`, the same bearer-keyed,
 * (tenantId, subject)-scoped JSON POST shape as every other sandbox
 * operation. One verb, `run`: the script's text, which staged files to
 * hand it, how long it may take; the answer is its exit, both streams,
 * what it was given and what it left behind, already staged.
 *
 * Closed when not enabled (503 `scripts_unavailable`), like every other
 * optional family. A caller that goes away before the answer — the chat
 * turn behind the call was stopped — takes the script with it: its
 * process tree is killed rather than left to run to its timeout unseen.
 */

import type { ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  scriptTimeoutMs,
  validateInputFileIds,
  validateScriptCode,
  type SandboxFileSummary,
} from '@renkei/connector-sandbox';
import type * as store from './store';
import { ScriptRunError, type ScriptRunner } from './scripts';

export interface ScriptHandlerDeps {
  db: Kysely<DB>;
  /** The runner, or null when the worker found no Python to run with. */
  runner: ScriptRunner | null;
}

type Body = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  sendJson(response, status, { error: { type, message } });
}

function targetOf(body: Body): store.SandboxTarget | null {
  const tenantId = str(body.tenantId);
  const subject = str(body.subject);
  if (!tenantId || !subject) return null;
  return { tenantId, subject };
}

function fileWire(summary: SandboxFileSummary) {
  return {
    id: summary.id,
    filename: summary.filename,
    contentType: summary.contentType,
    sizeBytes: summary.sizeBytes,
    source: summary.source,
    batchId: summary.batchId,
    createdAt: summary.createdAt.toISOString(),
    expiresAt: summary.expiresAt.toISOString(),
  };
}

const REFUSAL_STATUS = { not_found: 404, too_large: 413, busy: 429 } as const;

export function createScriptHandlers(deps: ScriptHandlerDeps) {
  async function run(body: Body, response: ServerResponse): Promise<void> {
    const runner = deps.runner;
    if (!runner) {
      return sendError(
        response,
        503,
        'scripts_unavailable',
        'Scripts are not enabled on this deployment.'
      );
    }
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const code = validateScriptCode(body.code);
    if (!code.ok) return sendError(response, 400, 'bad_request', code.message);
    const files = validateInputFileIds(body.files);
    if (!files.ok) return sendError(response, 400, 'bad_request', files.message);
    const timeoutMs = scriptTimeoutMs(body.timeoutMs);

    const gone = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) gone.abort();
    });

    let outcome: Awaited<ReturnType<ScriptRunner['run']>>;
    try {
      outcome = await runner.run(target, {
        code: code.code,
        fileIds: files.ids,
        timeoutMs,
        signal: gone.signal,
      });
    } catch (error) {
      if (error instanceof ScriptRunError) {
        return sendError(
          response,
          REFUSAL_STATUS[error.refusal.type],
          error.refusal.type,
          error.refusal.message
        );
      }
      throw error;
    }
    sendJson(response, 200, {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      interrupted: outcome.interrupted,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      timeoutMs: outcome.timeoutMs,
      inputs: outcome.inputs,
      outputs: outcome.outputs.map(fileWire),
      skippedOutputs: outcome.skippedOutputs,
      networkIsolated: outcome.networkIsolated,
      uidIsolated: outcome.uidIsolated,
    });
  }

  async function handleScripts(op: string, body: Body, response: ServerResponse): Promise<void> {
    if (op === 'run') return run(body, response);
    return sendError(response, 404, 'unknown_operation');
  }

  return { handleScripts };
}
