'use client';

/**
 * A code project's Services page: the containers running beside the
 * checkout — each with its image, status, address, the variables it
 * sets for every command, when it expires — its last log lines on
 * request, a Stop that removes it with its data, and a form to start
 * one: name, image, the container's own variables and what to export
 * into the project's commands, both as text (`KEY=value` a line, as a
 * `.env` reads). What may be started is the organization's allow-list,
 * shown as patterns so the image field is not a guess. Read on open and
 * after every change; the worker is the truth, and checks each service
 * against the engine as it lists it. Its summary card on the project
 * page is services-summary.tsx.
 *
 * The same verbs the chat has (code_service_start, code_service_stop,
 * code_service_logs), from the page: a person can have the database up
 * before asking for the work, and see and clean up what a chat started
 * without asking it. One column of cards at every width — a service is
 * a card, never a table row — so a phone gets the same page.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { WireService } from '@renkei/sandbox-client';
import type { ServicesView } from '@/lib/code/services';

const cardClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const linkButtonClass =
  'text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400';

interface StartDraft {
  name: string;
  image: string;
  env: string;
  exports: string;
}

const EMPTY_START: StartDraft = {
  name: 'db',
  image: 'postgres:16',
  env: 'POSTGRES_PASSWORD=test\nPOSTGRES_DB=app',
  exports: 'DATABASE_URL=postgres://postgres:test@{host}:{port}/app',
};

/** `db` → `SERVICE_DB`, as the worker names a service's variables. */
function envPrefix(name: string): string {
  return `SERVICE_${name.toUpperCase().replace(/-/g, '_')}`;
}

export default function ServicesPage({
  slug,
  tenantId,
  projectId,
  projectName,
  repoFullName,
  enabled,
  canEdit,
}: {
  slug: string;
  tenantId: string;
  projectId: string;
  projectName: string;
  repoFullName: string;
  /** The deployment offers services at all; off, the page says how to turn them on. */
  enabled: boolean;
  canEdit: boolean;
}) {
  const url = `/api/tenant/${tenantId}/code/projects/${projectId}/services`;
  const [view, setView] = useState<ServicesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<StartDraft | null>(null);
  /** The service just started from here, named until the next change. */
  const [started, setStarted] = useState<string | null>(null);
  /** Logs opened per service, by name. */
  const [logs, setLogs] = useState<Record<string, { text: string; truncated: boolean }>>({});

  const reload = useCallback(async () => {
    const result = await getJson<ServicesView>(url);
    if (result.data) {
      setView(result.data);
      setLoadError(null);
    } else setLoadError(result.error ?? 'The services could not be read.');
  }, [url]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const start = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setStarted(null);
    const result = await sendJsonFull<{ service: WireService }>(url, 'POST', {
      name: draft.name.trim(),
      image: draft.image.trim(),
      env: draft.env,
      exports: draft.exports,
    });
    if (result.error) setError(result.error);
    else {
      setStarted(result.data?.service.name ?? draft.name.trim());
      setDraft(null);
      await reload();
    }
    setBusy(false);
  };

  const stop = async (service: WireService) => {
    if (
      !window.confirm(
        `Stop ${service.name}? The container is removed with its data; the name is free again.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    setStarted(null);
    const result = await sendJsonFull(`${url}/${encodeURIComponent(service.name)}`, 'DELETE');
    if (result.error) setError(result.error);
    else {
      setLogs((current) => {
        const next = { ...current };
        delete next[service.name];
        return next;
      });
      await reload();
    }
    setBusy(false);
  };

  const showLogs = async (service: WireService) => {
    if (logs[service.name]) {
      setLogs((current) => {
        const next = { ...current };
        delete next[service.name];
        return next;
      });
      return;
    }
    setError(null);
    const result = await getJson<{ logs: string; truncated: boolean }>(
      `${url}/${encodeURIComponent(service.name)}?lines=200`
    );
    if (result.error || !result.data) {
      setError(result.error ?? 'The logs could not be read.');
      return;
    }
    const text = result.data.logs.replace(/\s+$/, '') || '(no output yet)';
    setLogs((current) => ({
      ...current,
      [service.name]: { text, truncated: result.data?.truncated === true },
    }));
  };

  const services = view?.services ?? [];
  const runningCount = services.filter((service) => service.status === 'running').length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
        <BackLink href={`/${slug}/code/${projectId}`} label={projectName} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <span className="truncate">Services</span>
            {view ? (
              <Pill tone={runningCount ? 'green' : 'gray'}>
                {runningCount ? `${runningCount} running` : 'None running'}
              </Pill>
            ) : null}
          </h1>
          <p className="truncate text-xs text-gray-500">
            {projectName} · <span className="font-mono">{repoFullName}</span>
          </p>
        </div>
        {enabled ? (
          <button
            type="button"
            disabled={busy || view === null}
            onClick={() => void reload()}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Refresh
          </button>
        ) : null}
      </header>

      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <p className="text-xs text-gray-500">
          Containers running beside this project&rsquo;s checkout for its tests &mdash; a database,
          a cache, a broker &mdash; from the images the organization allows. Every command a chat
          runs in the project gets each running service&rsquo;s address and what it exports. A chat
          can start and stop them too; here you can have one up before asking for the work, and
          clean up what a chat left behind.
        </p>
        {!enabled ? (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            Code project services are not enabled on this deployment. Set{' '}
            <code>SANDBOX_SERVICES_ENABLED=true</code> on the web app and the sandbox worker, and
            give the worker its Docker engine (see DEPLOYMENT.md), to turn them on.
          </p>
        ) : null}
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {enabled && view === null && !loadError ? (
          <p className="text-sm text-gray-500">Reading from the sandbox…</p>
        ) : null}
        {view ? (
          <div aria-busy={busy} className="space-y-4">
            <section className={cardClass} aria-labelledby="services-running">
              <div className="mb-2 flex items-center gap-2">
                <h2 id="services-running" className="text-sm font-semibold">
                  Running
                </h2>
                {canEdit && !draft ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft(EMPTY_START)}
                    className={`ml-auto ${linkButtonClass}`}
                  >
                    Start a service
                  </button>
                ) : null}
              </div>
              {started ? (
                <p role="status" className="mb-2 text-sm text-green-700 dark:text-green-400">
                  Started {started}. Give it a moment to become ready before running tests against
                  it.
                </p>
              ) : null}
              {draft ? (
                <StartForm
                  draft={draft}
                  busy={busy}
                  allowed={view.allowed}
                  onChange={setDraft}
                  onCancel={() => setDraft(null)}
                  onSubmit={() => void start()}
                />
              ) : null}
              {services.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No services.{' '}
                  {canEdit ? 'Start one here, or ask a chat in the project for one.' : ''}
                </p>
              ) : (
                <ul className="space-y-3" aria-label="Services">
                  {services.map((service) => (
                    <li
                      key={service.id}
                      className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{service.name}</span>
                        <ServiceStatusPill status={service.status} />
                        <span className="min-w-0 truncate font-mono text-xs text-gray-500">
                          {service.image}
                        </span>
                        <span className="ml-auto flex gap-3">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void showLogs(service)}
                            className={linkButtonClass}
                          >
                            {logs[service.name] ? 'Hide logs' : 'Logs'}
                          </button>
                          {canEdit ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void stop(service)}
                              className="text-xs font-medium whitespace-nowrap text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                            >
                              Stop
                            </button>
                          ) : null}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {service.status === 'running' && service.host ? (
                          <>
                            At <span className="font-mono">{service.host}</span>
                            {service.ports.length ? (
                              <>
                                {' '}
                                on port{service.ports.length === 1 ? '' : 's'}{' '}
                                <span className="font-mono">{service.ports.join(', ')}</span>
                              </>
                            ) : null}
                            {' · sets '}
                            <span className="font-mono">
                              {[
                                `${envPrefix(service.name)}_HOST`,
                                ...(service.ports.length
                                  ? [`${envPrefix(service.name)}_PORT`]
                                  : []),
                                ...service.exportNames,
                              ].join(', ')}
                            </span>
                            {' for every command'}
                          </>
                        ) : (
                          (service.error ?? 'Not running.')
                        )}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Started <LocalTime at={service.createdAt} /> · removed{' '}
                        <LocalTime at={service.expiresAt} /> unless a command uses it
                      </p>
                      {logs[service.name] ? (
                        <pre
                          aria-label={`${service.name} logs`}
                          className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-gray-900"
                        >
                          {logs[service.name]!.truncated ? '[the start was cut]\n' : ''}
                          {logs[service.name]!.text}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={cardClass} aria-labelledby="services-allowed">
              <h2 id="services-allowed" className="mb-2 text-sm font-semibold">
                Allowed images
              </h2>
              {view.allowed.length === 0 ? (
                <p className="text-sm text-gray-500">
                  The organization allows no images yet, so nothing can be started. An operator sets
                  the list under Organization &rarr; Code services.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-gray-500">
                    A whole registry, a namespace on one, or a single repository at any tag. Set by
                    an operator under{' '}
                    <Link href={`/${slug}/admin/code-services`} className="underline">
                      Organization &rarr; Code services
                    </Link>
                    .
                  </p>
                  <ul className="flex flex-wrap gap-1.5" aria-label="Allowed images">
                    {view.allowed.map((pattern) => (
                      <li
                        key={pattern}
                        className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-800"
                      >
                        {pattern}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StartForm({
  draft,
  busy,
  allowed,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: StartDraft;
  busy: boolean;
  allowed: string[];
  onChange: (draft: StartDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      aria-label="Start a service"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="mb-3 space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800"
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="block text-xs font-medium">
          Name
          <input
            className={`${inputClass} mt-1 font-mono`}
            value={draft.name}
            maxLength={32}
            pattern="[a-z][a-z0-9-]{0,31}"
            placeholder="db"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="block text-xs font-medium">
          Image
          <input
            className={`${inputClass} mt-1 font-mono`}
            value={draft.image}
            maxLength={512}
            list="allowed-images"
            placeholder="postgres:16"
            onChange={(event) => onChange({ ...draft, image: event.target.value })}
          />
          <datalist id="allowed-images">
            {allowed.map((pattern) => (
              <option
                key={pattern}
                value={pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern}
              />
            ))}
          </datalist>
        </label>
      </div>
      <label className="block text-xs font-medium">
        Container variables (what the image reads to set itself up)
        <textarea
          className={`${inputClass} mt-1 font-mono`}
          value={draft.env}
          rows={3}
          spellCheck={false}
          onChange={(event) => onChange({ ...draft, env: event.target.value })}
        />
      </label>
      <label className="block text-xs font-medium">
        Exports (set for every command while it runs; {'{host}'} and {'{port}'} are filled in)
        <textarea
          className={`${inputClass} mt-1 font-mono`}
          value={draft.exports}
          rows={2}
          spellCheck={false}
          onChange={(event) => onChange({ ...draft, exports: event.target.value })}
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        <p className="mr-auto text-xs text-gray-500">
          A throwaway password is fine: it is a test service, removed after a day idle.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !draft.name.trim() || !draft.image.trim()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </form>
  );
}

export function ServiceStatusPill({ status }: { status: WireService['status'] }) {
  const tone =
    status === 'running'
      ? 'green'
      : status === 'starting'
        ? 'blue'
        : status === 'failed'
          ? 'red'
          : 'gray';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Pill tone={tone}>{label}</Pill>;
}

function Pill({ tone, children }: { tone: 'green' | 'blue' | 'red' | 'gray'; children: string }) {
  const tones = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
