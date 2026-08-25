/**
 * Sandboxed execution of admin-authored cleaner scripts.
 *
 * Literal phrases cover fixed boilerplate; a script covers what strings
 * cannot — "drop everything after the third pipe-separated social row",
 * "collapse the address block whatever office it names". That power is
 * exactly why this repo refused admin-supplied REGEX (a shared-process
 * engine that can backtrack for minutes, see redactionMrnFormats); scripts
 * are allowed only because they run somewhere strictly stronger than a
 * regex engine is weak: a QuickJS WebAssembly interpreter with
 *
 *   - no host surface at all — no require, no fetch, no fs, no process;
 *     the guest can compute over the strings it was handed and nothing else,
 *   - a hard wall-clock interrupt (default 250ms) that stops infinite loops,
 *   - a memory ceiling (default 32MB) that stops allocation bombs,
 *   - an output contract: a string within size bounds, or the run is void.
 *
 * And the pipeline treats every failure as a no-op: a broken script never
 * eats a message — the text passes through unchanged and the error lands on
 * the script's own row for the admin page to show. quickjs-emscripten was
 * chosen over isolated-vm (native build — the alpine problem) and the
 * wrapper packages (extra third-party deps): it is pure WASM and its entire
 * dependency tree is same-author build variants.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * What a script may be pointed at. Mail was the only kind when scripts
 * shipped; invites and tasks reach the same stage now, and a script says
 * which of them it is willing to handle.
 */
export type CleanerScriptKind = 'msg' | 'evt' | 'task';

export interface CleanerScriptInput {
  /** The message text as cleaned so far — what the script transforms. */
  text: string;
  /**
   * Which kind of thing `text` came from.
   *
   * Handed to the guest so one script can serve several kinds without
   * guessing from the shape of the text — `if (email.kind !== 'evt') return
   * email.text` is the whole idiom. Defaults to 'msg' so every existing
   * script, written when mail was all there was, reads exactly as before.
   */
  kind?: CleanerScriptKind;
  subject: string;
  fromAddress: string;
  fromName: string;
  /**
   * The header-level fields the connectors capture — the system-relay
   * tells (see types.ts on each): the authenticated Sender when it differs
   * from From, the Reply-To, the Message-ID, and the received timestamp.
   * Null when the connector reported none.
   */
  senderAddress?: string | null;
  replyToAddress?: string | null;
  messageId?: string | null;
  receivedAt?: string | null;
  /**
   * Calendar fields, empty for other kinds. An invite's structure is where
   * its boilerplate is anchored — a script that strips a conferencing block
   * usually wants to know whether the meeting is online at all.
   */
  organizer?: string | null;
  attendees?: readonly string[];
  location?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  isOnline?: boolean;
}

export interface CleanerScriptLimits {
  /** Wall-clock budget for one run. */
  deadlineMs?: number;
  /** Guest heap ceiling, bytes. */
  memoryLimitBytes?: number;
  /** Longest output accepted, chars. */
  maxOutputChars?: number;
}

export type CleanerScriptError =
  | { type: 'SCRIPT_THREW'; message: string }
  | { type: 'TIMEOUT'; message: string }
  | { type: 'BAD_OUTPUT'; message: string };

const DEFAULT_DEADLINE_MS = 250;
const DEFAULT_MEMORY_LIMIT = 32 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT = 200_000;
export const MAX_SCRIPT_CHARS = 20_000;

/** One engine per process — the wasm module is the expensive part. */
let enginePromise: Promise<QuickJSWASMModule> | null = null;
function engine(): Promise<QuickJSWASMModule> {
  if (!enginePromise) enginePromise = getQuickJS();
  return enginePromise;
}

/**
 * Save-time check: does the source even evaluate to a function? Catches
 * syntax errors and "forgot the arrow" at the moment of saving instead of
 * as a last_error hours later. Runtime behavior is deliberately NOT
 * checked here — a script may legitimately throw on a probe input.
 */
export async function validateCleanerScriptSource(
  script: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const quickjs = await engine();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(DEFAULT_MEMORY_LIMIT);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 100));
  const context = runtime.newContext();
  try {
    const evaluated = context.evalCode(`typeof (\n${script}\n) === 'function'`);
    if (evaluated.error) {
      const dumped: unknown = context.dump(evaluated.error);
      evaluated.error.dispose();
      const message =
        typeof dumped === 'object' && dumped !== null && 'message' in dumped
          ? String(dumped.message)
          : 'The script could not be parsed.';
      return { ok: false, error: message.slice(0, 300) };
    }
    const isFunction: unknown = context.dump(evaluated.value);
    evaluated.value.dispose();
    if (isFunction !== true) {
      return { ok: false, error: 'The script must be a function: (email) => string.' };
    }
    return { ok: true };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/**
 * Run one script over one message. The script must BE a function —
 * `(email) => string`, arrow or function expression — that reads
 * `email.text` (and subject/fromAddress/fromName) and returns the
 * transformed text. The signature is enforced, not assumed: source that
 * does not evaluate to a function, and a call that does not return a
 * string, are both errors — never adopted output. Deterministic on
 * purpose: there is no clock, no IO, nothing to reach for.
 */
export async function runCleanerScript(
  script: string,
  input: CleanerScriptInput,
  limits: CleanerScriptLimits = {}
): Promise<Result<string, CleanerScriptError['type']> & { detail?: string }> {
  const deadlineMs = limits.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxOutput = limits.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

  const quickjs = await engine();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + deadlineMs));
  const context = runtime.newContext();

  try {
    // The input crosses the boundary as JSON text — no handles to host
    // objects, so there is nothing on the guest side that references the
    // host at all.
    const source =
      `const email = ${JSON.stringify({
        text: input.text,
        subject: input.subject,
        fromAddress: input.fromAddress,
        fromName: input.fromName,
        senderAddress: input.senderAddress ?? null,
        replyToAddress: input.replyToAddress ?? null,
        messageId: input.messageId ?? null,
        receivedAt: input.receivedAt ?? null,
        kind: input.kind ?? 'msg',
        organizer: input.organizer ?? null,
        attendees: input.attendees ? [...input.attendees] : [],
        location: input.location ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        isOnline: input.isOnline ?? false,
      })};\n` +
      // `item` is the same object under a name that does not lie when the
      // thing in hand is a meeting. `email` stays because scripts already
      // written against it must keep working.
      `const item = email;\n` +
      // Parenthesised so arrow and function expressions both evaluate;
      // the signature check is what makes "must be (email) => string" a
      // contract rather than documentation.
      `const __fn = (\n${script}\n);\n` +
      `if (typeof __fn !== 'function') { throw new Error('the script must be a function: (email) => string'); }\n` +
      `const __result = __fn(email);\n` +
      `if (typeof __result !== 'string') { throw new Error('the function must return a string'); }\n` +
      `__result;`;

    const evaluated = context.evalCode(source);
    if (evaluated.error) {
      // dump() hands back the guest error as a plain object ({name,
      // message, stack}) — String() on that is "[object Object]".
      const dumped: unknown = context.dump(evaluated.error);
      evaluated.error.dispose();
      let message = 'script error';
      if (typeof dumped === 'string') {
        message = dumped;
      } else if (typeof dumped === 'object' && dumped !== null) {
        const { name, message: text }: { name?: unknown; message?: unknown } = dumped;
        message =
          [typeof name === 'string' ? name : '', typeof text === 'string' ? text : '']
            .filter(Boolean)
            .join(': ') || JSON.stringify(dumped).slice(0, 200);
      }
      const timedOut = /interrupt/i.test(message);
      return {
        ...err(timedOut ? ('TIMEOUT' as const) : ('SCRIPT_THREW' as const)),
        detail: timedOut ? `Ran past the ${deadlineMs}ms budget.` : message.slice(0, 300),
      };
    }

    const value: unknown = context.dump(evaluated.value);
    evaluated.value.dispose();
    if (typeof value !== 'string') {
      return { ...err('BAD_OUTPUT' as const), detail: 'The script did not return a string.' };
    }
    if (value.length > maxOutput) {
      return {
        ...err('BAD_OUTPUT' as const),
        detail: `Output exceeded ${maxOutput} characters.`,
      };
    }
    return ok(value);
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
