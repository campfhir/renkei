/**
 * What this instance is doing right now, written down as it goes, so
 * that a death nobody announced can be explained afterwards.
 *
 * A worker that throws says so before it exits, and one asked to stop
 * says that too. One that is killed outright — by the machine running
 * out of memory, by a crash in native code — says nothing: its log
 * simply starts again. The first deployment at scale had exactly that,
 * an instance restarting every time one project was used, with no line
 * to say why.
 *
 * So each request is noted in a small file as it begins (its verb, who
 * it is for, the checkout and path it names — never a command's or a
 * cell's text) and struck from it as it ends. A clean stop leaves the file empty. A start that finds requests
 * still in it knows the last run ended without a word while those were
 * under way, and says which — once, as a warning — before clearing it.
 *
 * The file is `<data>/instances/<instance id>.inflight.json`, this
 * instance's own. A request's beginning is written before it is handled
 * (synchronously: a request that kills the process at once must already
 * be on disk); its end is written when convenient. Messages to a
 * language server are too many to note and are left out.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '@renkei/guards';

export interface InflightEntry {
  /** The verb, as the URL names it: `workspaces/kernel/execute`. */
  op: string;
  /** Who it is for, when the request says. */
  subject: string | null;
  /** Where it points — a checkout's id, a path — when the request says. */
  detail: string | null;
  /** When it began, ISO. */
  at: string;
}

/** Verbs noted nowhere: one per keystroke, and never the cause. */
const UNNOTED = new Set(['workspaces/lsp/send']);
const DETAIL_MAX = 200;

/** The part of a request worth having when it turns out to be the last one. */
export function detailOf(body: Record<string, unknown>): string | null {
  // Where it points, never what it carries: a command's text, a cell's
  // code and a URL's query can hold a secret, and this goes to disk and
  // to the log.
  const parts: string[] = [];
  for (const key of ['id', 'path', 'glob', 'name']) {
    const value = body[key];
    if (typeof value === 'string' && value) parts.push(`${key}: ${value.slice(0, DETAIL_MAX)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

export class Inflight {
  private readonly entries = new Map<number, InflightEntry>();
  private nextId = 1;
  private writing = false;
  private stale = false;

  constructor(private readonly file: string | null) {}

  /** Note a request as begun; call what comes back when it has been answered. */
  begin(op: string, subject: string, body: Record<string, unknown>): () => void {
    if (!this.file || UNNOTED.has(op)) return () => undefined;
    const id = this.nextId++;
    this.entries.set(id, {
      op,
      subject: subject || null,
      detail: detailOf(body),
      at: new Date().toISOString(),
    });
    // Before it is handled: if this is the request that ends the process,
    // it is already written down.
    try {
      writeFileSync(this.file, this.serialized());
    } catch {
      // A disk that cannot be written is no reason to refuse the request.
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.entries.delete(id);
      this.persistSoon();
    };
  }

  /** What is under way now. */
  current(): InflightEntry[] {
    return [...this.entries.values()];
  }

  private serialized(): string {
    return JSON.stringify(this.current());
  }

  /** An end is written when the last write is done, the latest state winning. */
  private persistSoon(): void {
    if (!this.file) return;
    if (this.writing) {
      this.stale = true;
      return;
    }
    this.writing = true;
    void writeFile(this.file, this.serialized())
      .catch(() => undefined)
      .then(() => {
        this.writing = false;
        if (this.stale) {
          this.stale = false;
          this.persistSoon();
        }
      });
  }

  /** A clean stop: nothing was under way that anyone need hear about. */
  clear(): void {
    this.entries.clear();
    if (!this.file) return;
    try {
      writeFileSync(this.file, '[]');
    } catch {
      // Nothing to add.
    }
  }
}

/** Where an instance keeps its note, made ready; null when the directory cannot be made. */
export function inflightFile(dataRoot: string, instance: string): string | null {
  const directory = join(dataRoot, 'instances');
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return null;
  }
  // An instance's name is a hostname; nothing in it may leave the directory.
  return join(directory, `${instance.replace(/[^A-Za-z0-9._-]/g, '_')}.inflight.json`);
}

/**
 * What the last run of this instance left under way — the requests it
 * was handling when it ended without saying so — and the note cleared
 * for this run. Empty after a clean stop, a first start, or a note that
 * cannot be read.
 */
export function takePreviousInflight(file: string | null): InflightEntry[] {
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    writeFileSync(file, '[]');
  } catch {
    // Reported again next start, then; better twice than not at all.
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: InflightEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.op !== 'string') continue;
    entries.push({
      op: entry.op,
      subject: typeof entry.subject === 'string' ? entry.subject : null,
      detail: typeof entry.detail === 'string' ? entry.detail : null,
      at: typeof entry.at === 'string' ? entry.at : '',
    });
  }
  return entries;
}

/** The warning's sentence about one request: its verb, who it is for, where it points, since when. */
export function describeInflight(entry: InflightEntry): string {
  const who = entry.subject ? ` for ${entry.subject}` : '';
  const what = entry.detail ? ` (${entry.detail})` : '';
  const since = entry.at ? ` since ${entry.at}` : '';
  return `${entry.op}${who}${what}${since}`;
}
