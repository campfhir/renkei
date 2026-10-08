/**
 * Scripts over staged files — the pure half of `sandbox_run_python`:
 * the bounds a run is held to, what a script may be called and handed,
 * and how the files it writes are named and typed on their way back
 * into the scratch space. The worker that copies the inputs in, drops
 * the interpreter to the caller's uid with no network, and stages the
 * outputs back is apps/worker-sandbox (src/scripts.ts); the tool is
 * apps/web's. Both go through exactly this code so a script is refused
 * the same way everywhere.
 *
 * Why a script, after "curated verbs, not a shell": a spreadsheet of
 * five thousand rows matched against one of seventy thousand by MRN is
 * not a thing a model should do by reading text dumps and retyping —
 * at that scale the wrong phone number lands on the wrong patient and
 * nothing looks wrong. The data-level step has to be a program, and the
 * program has to run where the files are. So, as with code workspaces,
 * the line moves from WHAT runs to WHO runs it and WHERE: a throwaway
 * directory holding copies of the caller's own staged files, the
 * caller's own unprivileged uid, no network, a memory and process
 * ceiling, a wall clock — and nothing it writes leaves except through
 * the same quota every other staged file is held to.
 */

import { validateFilename } from './naming';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Source text in one call; a script, not a program. */
export const SCRIPT_CODE_MAX_CHARS = 64_000;
export const SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
/** The same ceiling as a workspace command: one tool call's wait. */
export const SCRIPT_MAX_TIMEOUT_MS = 10 * 60_000;
/** Staged files handed to one run, and files one run may hand back. */
export const SCRIPT_MAX_INPUT_FILES = 50;
export const SCRIPT_MAX_OUTPUT_FILES = 50;
/** Bytes copied into a run's `in/` across every input. */
export const SCRIPT_MAX_INPUT_BYTES = 1_073_741_824; // 1GB
/** Address space one run may take (RLIMIT_AS); pandas on a 70k-row sheet sits well under it. */
export const SCRIPT_MAX_MEMORY_BYTES = 2 * 1_073_741_824; // 2GB
/** Processes one run may have at once (per uid, so a fork bomb stops here). */
export const SCRIPT_MAX_PROCESSES = 64;
/** Output to the model: the workspace command's defaults. */
export const SCRIPT_OUTPUT_DEFAULT_CHARS = 30_000;
export const SCRIPT_OUTPUT_MAX_CHARS = 100_000;
/** Runs one worker process has going at once, and one caller at once. */
export const SCRIPT_MAX_CONCURRENT_RUNS = 4;

/** The directories a script sees in its working directory. */
export const SCRIPT_INPUT_DIR = 'in';
export const SCRIPT_OUTPUT_DIR = 'out';
export const SCRIPT_MAIN_FILE = 'main.py';

export const SCRIPT_LANGUAGES = ['python'] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateScriptCode(
  input: unknown
): { ok: true; code: string } | { ok: false; message: string } {
  const code = typeof input === 'string' ? input : '';
  if (!code.trim()) return { ok: false, message: 'A script is required.' };
  if (code.length > SCRIPT_CODE_MAX_CHARS) {
    return { ok: false, message: `A script is at most ${SCRIPT_CODE_MAX_CHARS} characters.` };
  }
  if (code.includes('\0')) return { ok: false, message: 'A script cannot contain a null byte.' };
  return { ok: true, code };
}

/** Bound a caller's timeout request to what one run may take. */
export function scriptTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return SCRIPT_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(SCRIPT_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(value)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The staged file ids a run is handed: each a UUID, no repeats, at most
 * SCRIPT_MAX_INPUT_FILES. Absent or empty means "every file I have staged",
 * which the worker resolves and bounds the same way.
 */
export function validateInputFileIds(
  input: unknown
): { ok: true; ids: string[] | null } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, ids: null };
  if (!Array.isArray(input)) return { ok: false, message: 'files must be a list of file ids.' };
  if (input.length === 0) return { ok: true, ids: null };
  if (input.length > SCRIPT_MAX_INPUT_FILES) {
    return { ok: false, message: `A run takes at most ${SCRIPT_MAX_INPUT_FILES} files.` };
  }
  const ids: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !UUID.test(raw)) {
      return { ok: false, message: 'Each entry in files must be a staged file id.' };
    }
    if (!ids.includes(raw)) ids.push(raw);
  }
  return { ok: true, ids };
}

// ─── Names on the way in and out ────────────────────────────────────────────

/**
 * The name each input file is copied in as, under `in/`. Staged files
 * are not unique by name (two pulls of `report.xlsx`), and a script reads
 * them by name, so a repeat gets a counter before its extension:
 * `report.xlsx`, `report (2).xlsx`. Names are already past
 * `validateFilename` (no separators, no traversal); a name that somehow
 * is not falls back to the file's own id so the run never fails on it.
 */
export function inputNamesFor(
  files: ReadonlyArray<{ id: string; filename: string }>
): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const file of files) {
    const checked = validateFilename(file.filename);
    const base = checked.ok ? checked.filename : file.id;
    let candidate = base;
    for (let counter = 2; taken.has(candidate.toLowerCase()); counter += 1) {
      const dot = base.lastIndexOf('.');
      candidate =
        dot > 0 ? `${base.slice(0, dot)} (${counter})${base.slice(dot)}` : `${base} (${counter})`;
    }
    taken.add(candidate.toLowerCase());
    names.set(file.id, candidate);
  }
  return names;
}

/**
 * What a file a script wrote is staged as. Extension-led, the common
 * data and document types; anything else is bytes. Kept here rather
 * than in @renkei/document-render because the worker does not carry
 * that package, and a model-facing list of what to name things is the
 * tool description's job, not this one's.
 */
const OUTPUT_MEDIA_TYPES: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  xml: 'application/xml',
  html: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  parquet: 'application/vnd.apache.parquet',
  zip: 'application/zip',
};

export function outputMediaType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return OUTPUT_MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Whether a name a script gave a file under `out/` can be a staged
 * file's name: `validateFilename`'s rule, plus nothing hidden (a
 * `.cache` a library left behind is not a result).
 */
export function validateOutputName(name: string): { ok: true; filename: string } | { ok: false } {
  const checked = validateFilename(name);
  if (!checked.ok || checked.filename.startsWith('.')) return { ok: false };
  return checked;
}
