'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';

/* ----------------------------------------------------------------------- */

interface EmbeddingsConfig {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  queryPrefix?: string;
  passagePrefix?: string;
  maxDistance?: number | null;
}

export function EmbeddingsForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/embeddings`;
  const [state, reload] = useConnectorConfig<EmbeddingsConfig>(url);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [queryPrefix, setQueryPrefix] = useState('');
  const [passagePrefix, setPassagePrefix] = useState('');
  const [maxDistance, setMaxDistance] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setBaseUrl(state.data.baseUrl ?? '');
    setModel(state.data.model ?? '');
    setQueryPrefix(state.data.queryPrefix ?? '');
    setPassagePrefix(state.data.passagePrefix ?? '');
    setMaxDistance(
      typeof state.data.maxDistance === 'number' ? String(state.data.maxDistance) : ''
    );
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      // Prefixes are NOT trimmed: for the models that want one, the
      // trailing space is part of it ("query: ").
      queryPrefix,
      passagePrefix,
      maxDistance: maxDistance.trim(),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Embeddings" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Embeddings" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Embeddings"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        The provider the knowledge layer uses to embed content for retrieval.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="em-base" className={labelClass}>
            Base URL
          </label>
          <input
            id="em-base"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="em-model" className={labelClass}>
            Model
          </label>
          <input
            id="em-model"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-3-small"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="em-key" className={labelClass}>
            API key
          </label>
          <input
            id="em-key"
            type="password"
            required={!config?.hasApiKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>A key is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="em-qprefix" className={labelClass}>
              Query prefix
            </label>
            <input
              id="em-qprefix"
              value={queryPrefix}
              onChange={(e) => setQueryPrefix(e.target.value)}
              placeholder="query: "
              className={`${inputClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="em-pprefix" className={labelClass}>
              Passage prefix
            </label>
            <input
              id="em-pprefix"
              value={passagePrefix}
              onChange={(e) => setPassagePrefix(e.target.value)}
              placeholder="passage: "
              className={`${inputClass} font-mono`}
            />
          </div>
        </div>
        <p className={hintClass}>
          Only for models that embed queries and documents differently (e5, bge, nomic, mxbai —
          typically served through vLLM, TEI or Ollama). Prepended verbatim, trailing space
          included. Leave both blank for OpenAI, Cohere, Voyage and similar. Changing the passage
          prefix means re-indexing.
        </p>
        <div>
          <label htmlFor="em-cutoff" className={labelClass}>
            Relevance cutoff (cosine distance)
          </label>
          <input
            id="em-cutoff"
            inputMode="decimal"
            value={maxDistance}
            onChange={(e) => setMaxDistance(e.target.value)}
            placeholder="blank = no cutoff"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Matches farther than this are dropped and reported as a count, and result grades (strong
            / good / possible) are scaled to it. Model-specific: around 0.55 suits bge or e5, around
            0.75 suits text-embedding-3. Keyword matches are always kept.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
      {config?.configured && <ReindexPanel slug={slug} />}
    </Card>
  );
}

/* ----------------------------------------------------------------------- */

type ReindexKind = 'lexical' | 'embed' | 'keywords';

interface ReindexRun {
  id: string;
  kind: ReindexKind;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const REINDEX_ACTIONS: { kind: ReindexKind; label: string; hint: string; unit: string }[] = [
  {
    kind: 'lexical',
    label: 'Rebuild keyword index',
    hint: 'Fills the exact-word index for items indexed before it existed. No provider calls; safe to run any time.',
    unit: 'chunks',
  },
  {
    kind: 'embed',
    label: 'Re-embed with context headers',
    hint: 'Recomputes the vectors of multi-part items so every part knows its document. One embeddings call per 64 chunks; run after changing the model or the passage prefix.',
    unit: 'chunks',
  },
  {
    kind: 'keywords',
    label: 'Extract keywords for existing items',
    hint: 'One call to the default LLM model per item that has none yet. Only when keyword enrichment is on under Settings.',
    unit: 'items',
  },
];

/** The route's `runs` list, field-checked rather than trusted. */
function readRuns(body: unknown): ReindexRun[] {
  if (typeof body !== 'object' || body === null) return [];
  const runs = Reflect.get(body, 'runs');
  if (!Array.isArray(runs)) return [];
  const out: ReindexRun[] = [];
  for (const entry of runs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record: Record<string, unknown> = { ...entry };
    const kind = record.kind;
    if (kind !== 'lexical' && kind !== 'embed' && kind !== 'keywords') continue;
    if (typeof record.id !== 'string' || typeof record.status !== 'string') continue;
    out.push({
      id: record.id,
      kind,
      status: record.status,
      processed: typeof record.processed === 'number' ? record.processed : 0,
      skipped: typeof record.skipped === 'number' ? record.skipped : 0,
      failed: typeof record.failed === 'number' ? record.failed : 0,
      lastError: typeof record.lastError === 'string' ? record.lastError : null,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
      finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    });
  }
  return out;
}

function isActive(run: ReindexRun | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

/** Paused or failed: stopped, but its cursor makes it resumable rather than a do-over. */
function isResumable(run: ReindexRun | undefined): boolean {
  return run?.status === 'paused' || run?.status === 'failed';
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function runSummary(run: ReindexRun | undefined, unit: string): string {
  if (!run) return 'Never run';
  const count = `${run.processed.toLocaleString()} ${unit}`;
  switch (run.status) {
    case 'queued':
      return 'Queued…';
    case 'running':
      return `Running — ${count} so far`;
    case 'done':
      return (
        `Done ${relativeTime(run.finishedAt)} — ${count}` +
        (run.skipped > 0 ? `, ${run.skipped} unreadable skipped` : '') +
        (run.failed > 0 ? `, ${run.failed} failed` : '')
      );
    case 'failed':
      return `Failed ${relativeTime(run.finishedAt ?? run.createdAt)} after ${count}: ${run.lastError ?? 'unknown error'}`;
    case 'paused':
      return `Paused — ${count} so far`;
    default:
      return run.status;
  }
}

type ReindexAction = 'start' | 'pause' | 'resume';

const primaryButtonClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800';
const secondaryButtonClass =
  'rounded-md px-3 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800';

/**
 * The reindex buttons. Each starts a queue-driven run the worker chains
 * through in short batches; this panel only asks and watches. Polls while
 * anything is running, and stops when nothing is — a page left open does
 * not keep hitting the server for a run that ended an hour ago.
 *
 * A run's own stored cursor is what lets Resume pick up a paused or failed
 * run instead of redoing it: Pause (shown next to an active run) stops the
 * chain after its current in-flight link; Resume (shown for a paused or
 * failed run) re-arms it from where it stopped; Start fresh discards that
 * history and begins a brand new run at the top.
 */

function ReindexPanel({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/embeddings/reindex`;
  const [runs, setRuns] = useState<ReindexRun[] | null>(null);
  const [busy, setBusy] = useState<{ kind: ReindexKind; action: ReindexAction } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = new Map<ReindexKind, ReindexRun>();
  for (const run of runs ?? []) if (!latest.has(run.kind)) latest.set(run.kind, run);
  const anyActive = [...latest.values()].some(isActive);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(url).catch(() => null);
      const body: unknown = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      setRuns(readRuns(body));
    }
    void load();
    if (!anyActive)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, anyActive]);

  async function act(kind: ReindexKind, action: ReindexAction, runId?: string) {
    setBusy({ kind, action });
    setError(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, action, ...(runId ? { runId } : {}) }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (!response.ok) {
        setError(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      if (Array.isArray(record.runs)) setRuns(readRuns(body));
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-800">
      <p className="text-sm font-semibold">Reindex</p>
      <p className={hintClass}>
        Bring already-indexed content up to date with the current search pipeline. Runs in the
        background in batches; search keeps working meanwhile. Re-syncing a source from its
        connector does the same for that source.
      </p>
      <div className="mt-3 space-y-3">
        {REINDEX_ACTIONS.map((action) => {
          const run = latest.get(action.kind);
          const active = isActive(run);
          const resumable = isResumable(run);
          const disabled = busy !== null || runs === null;
          const busyWith = (a: ReindexAction) => busy?.kind === action.kind && busy.action === a;
          return (
            <div
              key={action.kind}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1"
            >
              <div className="min-w-0 max-w-md">
                <p className="text-sm font-medium">{action.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{action.hint}</p>
                <p
                  className={`mt-0.5 text-xs ${
                    run?.status === 'failed'
                      ? 'text-red-700 dark:text-red-300'
                      : active || run?.status === 'paused'
                        ? 'text-blue-700 dark:text-blue-400'
                        : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {runs === null ? 'Loading…' : runSummary(run, action.unit)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {active && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void act(action.kind, 'pause', run?.id)}
                    className={secondaryButtonClass}
                  >
                    {busyWith('pause') ? 'Pausing…' : 'Pause'}
                  </button>
                )}
                {resumable && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void act(action.kind, 'start')}
                    className={secondaryButtonClass}
                  >
                    {busyWith('start') ? 'Starting…' : 'Start fresh'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={active || disabled}
                  onClick={() => void act(action.kind, resumable ? 'resume' : 'start', run?.id)}
                  className={primaryButtonClass}
                >
                  {active
                    ? 'Running…'
                    : resumable
                      ? busyWith('resume')
                        ? 'Resuming…'
                        : 'Resume'
                      : busyWith('start')
                        ? 'Starting…'
                        : 'Run'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
