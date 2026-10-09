/**
 * What an attempt's `agent_run_steps.detail` keeps in the clear and what
 * it keeps sealed under the run owner's automation key.
 *
 * The row is the run's memory (docs/agents.md: a re-entry rebuilds the
 * variables from it) and the owner's timeline, so it holds the verbatim
 * prompt, the model's summary, every tool call's argument and result
 * preview, and the saved result — the run's whole content. Until now it
 * sat in a jsonb column in plaintext while the chats and credentials of
 * the same person were sealed under keys of their own. Now the
 * content-bearing fields travel as ONE `uenc1:` envelope (`sealed`),
 * sealed by the delegate under the owner's automation key — the key an
 * agent run already holds, so a crash re-entry and the compaction sweep
 * open it unattended, while a database copy alone shows nothing of what
 * the run read or wrote.
 *
 * What stays in the clear is what the timeline and the budget logic read
 * without a key: the declared outcome, token usage, model-call timings,
 * the names of the variables left unbound, and each tool call's NAME,
 * size, duration and error flag — never its arguments or result. A
 * reader without the owner's delegation sees those plus a marker where
 * the summary would be; a reader with it sees the row as before.
 *
 * This module is pure: it splits and merges. Who seals and opens (the
 * delegate client) is the caller's — the engine's and the web app's —
 * so this package stays free of the key store.
 */

/** The fields of a finished attempt's detail that are content, and so sealed. */
export const SEALED_DETAIL_FIELDS = [
  'promptText',
  'resolvedInstruction',
  'llmSummary',
  'guidanceUsed',
  'saveValue',
  'saveItems',
  'toolCalls',
] as const;

/** The envelope field a sealed detail carries. */
export const SEALED_DETAIL_KEY = 'sealed';

/** The one tool-call shape the clear half keeps: what ran, how long, how big, whether it failed. */
interface ToolCallOutline {
  tool?: unknown;
  free?: unknown;
  isError?: unknown;
  durationMs?: unknown;
  resultChars?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tool calls stripped to their outline — names and numbers, never previews. */
export function outlineToolCalls(toolCalls: unknown): ToolCallOutline[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((call): ToolCallOutline[] => {
    if (!isRecord(call)) return [];
    const outline: ToolCallOutline = {};
    if (typeof call.tool === 'string') outline.tool = call.tool;
    if (call.free === true) outline.free = true;
    if (call.isError === true) outline.isError = true;
    if (typeof call.durationMs === 'number') outline.durationMs = call.durationMs;
    if (typeof call.resultChars === 'number') outline.resultChars = call.resultChars;
    return [outline];
  });
}

/**
 * Split a finished attempt's detail into the half to store in the clear
 * and the JSON to seal. `plaintext` is null when the detail holds no
 * content field at all (nothing to seal; store `clear` as it is).
 */
export function splitDetailForSealing(detail: Record<string, unknown>): {
  clear: Record<string, unknown>;
  plaintext: string | null;
} {
  const clear: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SEALED_DETAIL_FIELDS.some((field) => field === key)) {
      if (value !== undefined) content[key] = value;
    } else if (key !== SEALED_DETAIL_KEY) {
      clear[key] = value;
    }
  }
  if (Object.keys(content).length === 0) return { clear, plaintext: null };
  if ('toolCalls' in content) clear.toolCalls = outlineToolCalls(content.toolCalls);
  return { clear, plaintext: JSON.stringify(content) };
}

/** The envelope on a stored detail, when it carries one. */
export function sealedDetailOf(detail: unknown): string | null {
  if (!isRecord(detail)) return null;
  const sealed = detail[SEALED_DETAIL_KEY];
  return typeof sealed === 'string' && sealed.length > 0 ? sealed : null;
}

/**
 * The stored detail with its content restored from the opened envelope —
 * or, when `opened` is null (the key is not delegated to this reader, or
 * the envelope would not open), with `llmSummary` set to the caller's
 * marker and `sealedUnavailable: true` so a timeline can say why. A
 * detail with no envelope (a row from before sealing, a pause row) comes
 * back as it is.
 */
export function mergeOpenedDetail(detail: unknown, opened: string | null, marker: string): unknown {
  if (!isRecord(detail) || sealedDetailOf(detail) === null) return detail;
  const { [SEALED_DETAIL_KEY]: _sealed, ...clear } = detail;
  if (opened === null) return { ...clear, llmSummary: marker, sealedUnavailable: true };
  let content: unknown;
  try {
    content = JSON.parse(opened);
  } catch {
    return { ...clear, llmSummary: marker, sealedUnavailable: true };
  }
  return isRecord(content)
    ? { ...clear, ...content }
    : { ...clear, llmSummary: marker, sealedUnavailable: true };
}
