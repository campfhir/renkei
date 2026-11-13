/**
 * A Jupyter notebook (`.ipynb`, nbformat 4) read for the code pane: the
 * file's JSON turned into the cells a person sees — markdown, code with
 * its execution count, and each code cell's outputs reduced to the one
 * thing to draw (text, a table's HTML, an image, a traceback) — and
 * changed for it: a cell's text, a run's outputs, a cell added, moved or
 * taken out, each as the file's new text with everything else in it left
 * as it was. Pure, so the pane's model and its tests work on notebooks
 * with it; drawing is notebook-view.tsx, running is the sandbox's kernel
 * (`…/notebook/kernel`).
 *
 * What a cell shows of a rich output is the richest form the pane can
 * draw, in `RICH_ORDER`; forms it cannot (widgets, JavaScript, Plotly's
 * own JSON) fall back to the output's `text/plain`. Terminal colour
 * codes are taken out of streams and tracebacks rather than drawn.
 */

import { isRecord, isString } from '@renkei/guards';

export type NotebookOutput =
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/svg+xml'; src: string }
  | { kind: 'error'; ename: string; evalue: string; traceback: string };

export type NotebookCell =
  | { type: 'markdown'; index: number; source: string }
  | { type: 'raw'; index: number; source: string }
  | {
      type: 'code';
      index: number;
      /** Its place among the code cells, from 1: the "cell 3" a failed run names. */
      number: number;
      source: string;
      executionCount: number | null;
      outputs: NotebookOutput[];
    };

export interface Notebook {
  cells: NotebookCell[];
  /** The cells' language, for colouring: 'python' unless the notebook says otherwise. */
  language: string;
  /** The kernel as the notebook names it ("Python 3 (ipykernel)"), when it does. */
  kernelName: string | null;
  codeCells: number;
  /** Code cells that carry any output. */
  withOutput: number;
}

export type NotebookParse = { ok: true; notebook: Notebook } | { ok: false; message: string };

/** Whether the code pane draws this file as a notebook. */
export function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith('.ipynb');
}

/** nbformat's "multiline string": one string, or its lines as a list. */
function multiline(value: unknown): string {
  if (isString(value)) return value;
  if (Array.isArray(value)) return value.filter(isString).join('');
  return '';
}

/** A terminal's escape sequence: ESC, `[`, parameters, a final letter. */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Terminal escape sequences (colour, cursor) taken out, and a `\r` rewrite resolved to its last text. */
export function plainTerminalText(text: string): string {
  const stripped = text.replace(ESCAPE_SEQUENCE, '').replace(/\r\n/g, '\n');
  if (!stripped.includes('\r')) return stripped;
  // A progress bar rewrites its line with carriage returns: keep what was left showing.
  return stripped
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif'] as const;

function richOutput(data: unknown): NotebookOutput | null {
  if (!isRecord(data)) return null;
  for (const mime of IMAGE_MIMES) {
    const base64 = multiline(data[mime]).replace(/\s+/g, '');
    if (base64 && /^[A-Za-z0-9+/=]+$/.test(base64)) {
      return { kind: 'image', mime, src: `data:${mime};base64,${base64}` };
    }
  }
  const svg = multiline(data['image/svg+xml']);
  if (svg.trim()) {
    // As an image, never as markup: an SVG drawn through <img> runs no script.
    return {
      kind: 'image',
      mime: 'image/svg+xml',
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    };
  }
  const html = multiline(data['text/html']);
  if (html.trim()) return { kind: 'html', html };
  const markdown = multiline(data['text/markdown']);
  if (markdown.trim()) return { kind: 'markdown', text: markdown };
  const latex = multiline(data['text/latex']);
  const plain = multiline(data['text/plain']);
  if (plain) return { kind: 'text', text: plainTerminalText(plain) };
  if (latex) return { kind: 'text', text: latex };
  return null;
}

function outputsOf(value: unknown): NotebookOutput[] {
  if (!Array.isArray(value)) return [];
  const outputs: NotebookOutput[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    switch (raw.output_type) {
      case 'stream': {
        const text = plainTerminalText(multiline(raw.text));
        if (!text) break;
        const name = raw.name === 'stderr' ? 'stderr' : 'stdout';
        const last = outputs[outputs.length - 1];
        if (last?.kind === 'stream' && last.name === name) last.text += text;
        else outputs.push({ kind: 'stream', name, text });
        break;
      }
      case 'execute_result':
      case 'display_data': {
        const rich = richOutput(raw.data);
        if (rich) outputs.push(rich);
        break;
      }
      case 'error': {
        const ename = isString(raw.ename) ? raw.ename : 'Error';
        const evalue = isString(raw.evalue) ? raw.evalue : '';
        const lines = Array.isArray(raw.traceback) ? raw.traceback.filter(isString) : [];
        outputs.push({
          kind: 'error',
          ename,
          evalue,
          traceback: plainTerminalText(lines.join('\n')) || `${ename}: ${evalue}`,
        });
        break;
      }
      default:
        break;
    }
  }
  return outputs;
}

/** Read a notebook's text; a file that is not one says why in a sentence. */
export function parseNotebook(text: string): NotebookParse {
  // A new, empty .ipynb: a notebook with no cells yet, to add the first to.
  if (!text.trim()) {
    return {
      ok: true,
      notebook: { cells: [], language: 'python', kernelName: null, codeCells: 0, withOutput: 0 },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'This file is not valid JSON, so it cannot be shown as a notebook.',
    };
  }
  if (!isRecord(value)) {
    return { ok: false, message: 'This file does not hold a notebook.' };
  }
  if (!Array.isArray(value.cells)) {
    return {
      ok: false,
      message:
        typeof value.nbformat === 'number' && value.nbformat < 4
          ? 'This notebook is in a format older than nbformat 4; convert it in Jupyter to see it here.'
          : 'This file does not hold a notebook’s cells.',
    };
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const language = (
    (isString(kernelspec.language) && kernelspec.language) ||
    (isString(languageInfo.name) && languageInfo.name) ||
    'python'
  ).toLowerCase();

  const cells: NotebookCell[] = [];
  let number = 0;
  let withOutput = 0;
  value.cells.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const source = multiline(raw.source);
    if (raw.cell_type === 'code') {
      number += 1;
      const outputs = outputsOf(raw.outputs);
      if (outputs.length > 0) withOutput += 1;
      cells.push({
        type: 'code',
        index,
        number,
        source,
        executionCount: typeof raw.execution_count === 'number' ? raw.execution_count : null,
        outputs,
      });
    } else if (raw.cell_type === 'markdown') {
      cells.push({ type: 'markdown', index, source });
    } else {
      cells.push({ type: 'raw', index, source });
    }
  });
  return {
    ok: true,
    notebook: {
      cells,
      language,
      kernelName: isString(kernelspec.display_name) ? kernelspec.display_name : null,
      codeCells: number,
      withOutput,
    },
  };
}

/** Written as Jupyter writes a notebook: one-space indent, a final newline. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

/** What a new, empty notebook file holds. */
function emptyDocument(): Record<string, unknown> {
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

/** The file as a document whose cells can be changed; null when it is not a notebook. */
function documentOf(text: string): { document: Record<string, unknown>; cells: unknown[] } | null {
  let value: unknown;
  if (!text.trim()) value = emptyDocument();
  else {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !Array.isArray(value.cells)) return null;
  return { document: value, cells: value.cells };
}

/** A cell's text as nbformat stores it: its lines, each keeping its newline. */
function sourceLines(source: string): string[] {
  return source ? source.split(/(?<=\n)/) : [];
}

/** The text of the cell at `index` (its place in the file's cells), or null. */
export function cellSource(text: string, index: number): string | null {
  const opened = documentOf(text);
  const cell = opened?.cells[index];
  return isRecord(cell) ? multiline(cell.source) : null;
}

/**
 * The notebook with the cell at `index` given new text. Everything else
 * in the file stays as it was — a code cell keeps its outputs, which are
 * then of an earlier text until it is run again, as in Jupyter. Null
 * when the file is not a notebook or has no such cell.
 */
export function setCellSource(text: string, index: number, source: string): string | null {
  const opened = documentOf(text);
  const cell = opened?.cells[index];
  if (!opened || !isRecord(cell)) return null;
  cell.source = sourceLines(source);
  return serialize(opened.document);
}

/** The notebook with a code cell's outputs and execution count replaced by a run's. */
export function setCellRun(
  text: string,
  index: number,
  outputs: unknown[],
  executionCount: number | null
): string | null {
  const opened = documentOf(text);
  const cell = opened?.cells[index];
  if (!opened || !isRecord(cell) || cell.cell_type !== 'code') return null;
  cell.outputs = outputs;
  cell.execution_count = executionCount;
  return serialize(opened.document);
}

/**
 * The notebook with a new, empty cell after the one at `after` (-1 puts
 * it first). `id` names the cell where the notebook's format has cell
 * ids (nbformat 4.5 on); the caller draws it, so this stays pure.
 */
export function insertCell(
  text: string,
  after: number,
  type: 'code' | 'markdown',
  id: string
): string | null {
  const opened = documentOf(text);
  if (!opened) return null;
  const { document, cells } = opened;
  const withIds =
    document.nbformat === 4 && typeof document.nbformat_minor === 'number'
      ? document.nbformat_minor >= 5
      : false;
  const cell: Record<string, unknown> =
    type === 'code'
      ? { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [] }
      : { cell_type: 'markdown', metadata: {}, source: [] };
  if (withIds) cell.id = id;
  const at = Math.min(Math.max(after + 1, 0), cells.length);
  cells.splice(at, 0, cell);
  return serialize(document);
}

/** The notebook without the cell at `index`. */
export function deleteCell(text: string, index: number): string | null {
  const opened = documentOf(text);
  if (!opened || index < 0 || index >= opened.cells.length) return null;
  opened.cells.splice(index, 1);
  return serialize(opened.document);
}

/** The notebook with the cell at `index` moved one place up (-1) or down (1). */
export function moveCell(text: string, index: number, by: -1 | 1): string | null {
  const opened = documentOf(text);
  if (!opened) return null;
  const to = index + by;
  const { cells } = opened;
  if (index < 0 || index >= cells.length || to < 0 || to >= cells.length) return null;
  [cells[index], cells[to]] = [cells[to], cells[index]];
  return serialize(opened.document);
}

/**
 * The notebook's text with every code cell's outputs and execution count
 * taken out, written as Jupyter writes a notebook (one-space indent, a
 * final newline). Null when the text is not a notebook.
 */
export function clearNotebookOutputs(text: string): string | null {
  if (!text.trim()) return null;
  const opened = documentOf(text);
  if (!opened) return null;
  for (const cell of opened.cells) {
    if (isRecord(cell) && cell.cell_type === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
  }
  return serialize(opened.document);
}
