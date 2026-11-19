'use client';

/**
 * A Fabric definition fetch, live: one EventSource on the operation's
 * stream while Fabric works, polling instead when the stream will not stay
 * open, and the definition — a notebook's cells, a pipeline's activities —
 * once it arrives. What the page makes of each message is
 * operation-view.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import { isRecord } from '@renkei/guards';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import { clientLogger } from '@/lib/client-logger';
import { readOperationView, type FabricOperationView } from '@/lib/fabric/operation-view';
import {
  POLL_MS,
  downloadName,
  headline,
  initialOperation,
  operationReducer,
  partTabs,
  progressLine,
  readPart,
  selectedPart,
} from './operation-view.model';

function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function OperationView({ initial }: { initial: FabricOperationView }) {
  const [state, dispatch] = useReducer(operationReducer, initial, initialOperation);
  const { operation, transport } = state;

  useEffect(() => {
    if (transport !== 'stream') return;
    const source = new EventSource(`/api/fabric/operations/${operation.id}/stream`);
    source.onopen = () => dispatch({ type: 'streamOpened' });
    source.onerror = () => dispatch({ type: 'streamFailed' });
    source.addEventListener('operation', (event: MessageEvent<string>) => {
      try {
        const view = readOperationView(JSON.parse(event.data));
        if (view) dispatch({ type: 'update', operation: view });
        if (view && view.status !== 'running') source.close();
      } catch (error) {
        clientLogger.warn('fabric/operation-stream', 'malformed operation event', error, {
          operationId: operation.id,
        });
      }
    });
    return () => source.close();
  }, [transport, operation.id]);

  useEffect(() => {
    if (transport !== 'polling') return;
    const timer = setInterval(() => {
      void fetch(`/api/fabric/operations/${operation.id}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          const view = isRecord(body) ? readOperationView(body.operation) : null;
          if (view) dispatch({ type: 'update', operation: view });
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [transport, operation.id]);

  const part = selectedPart(state);
  const reading = part ? readPart(part) : null;
  const progress = progressLine(state);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href="/fabric" label="Fabric" />
        <h1 className="min-w-0 truncate text-xl font-bold">{operation.itemName || 'Definition'}</h1>
        <span className="text-sm text-gray-500">
          {operation.workspaceName} · <LocalTime at={operation.createdAt} />
        </span>
      </div>

      <div role="status" aria-live="polite" className="mb-4">
        <p className="text-sm font-medium">{headline(state)}</p>
        {progress && <p className="text-sm text-gray-600 dark:text-gray-400">{progress}</p>}
        {operation.status === 'failed' && operation.error && (
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{operation.error}</p>
        )}
        {operation.status === 'running' && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
            <div
              className="h-full bg-blue-600 motion-safe:transition-all"
              style={{ width: `${operation.percentComplete ?? 5}%` }}
            />
          </div>
        )}
      </div>

      {operation.status === 'succeeded' && part && (
        <section aria-label="Definition">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Parts" className="flex flex-wrap gap-1">
              {partTabs(state).map((path) => (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={path === part.path}
                  onClick={() => dispatch({ type: 'partChosen', path })}
                  className={`rounded-md px-2 py-1 font-mono text-xs ${
                    path === part.path
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-900'
                  }`}
                >
                  {path}
                </button>
              ))}
            </div>
            {part.text !== null && (
              <button
                type="button"
                onClick={() => save(downloadName(state, part.path), part.text ?? '')}
                className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Download
              </button>
            )}
          </div>

          {reading?.kind === 'notebook' && (
            <ol aria-label="Cells" className="space-y-3">
              {reading.cells.map((cell, index) => (
                <li key={index} className="rounded-lg border border-gray-200 dark:border-gray-800">
                  <p className="border-b border-gray-200 px-3 py-1 text-xs text-gray-500 dark:border-gray-800">
                    Cell {index + 1} · {cell.kind}
                  </p>
                  <pre
                    className={`overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-sm ${
                      cell.kind === 'code' ? 'font-mono' : ''
                    }`}
                  >
                    {cell.source || ' '}
                  </pre>
                </li>
              ))}
            </ol>
          )}
          {reading?.kind === 'pipeline' && (
            <>
              <ul aria-label="Activities" className="mb-3 space-y-1 text-sm">
                {reading.activities.map((activity) => (
                  <li key={activity.name}>
                    <span className="font-medium">{activity.name}</span>{' '}
                    <span className="text-gray-500">
                      ({activity.type})
                      {activity.dependsOn.length ? ` after ${activity.dependsOn.join(', ')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs dark:bg-gray-900">
                {reading.json}
              </pre>
            </>
          )}
          {reading?.kind === 'text' && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 font-mono text-xs dark:bg-gray-900">
              {reading.text}
            </pre>
          )}
          {reading?.kind === 'binary' && (
            <p className="text-sm text-gray-500">This part is not text.</p>
          )}
        </section>
      )}
    </>
  );
}
