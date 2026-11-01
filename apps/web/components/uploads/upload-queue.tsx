'use client';

/**
 * Uploads that outlive the dialog they were started from. A dialog that
 * sends files itself is gone the moment the person clicks away, and
 * every file still on its way with it; so the sends live here, in a
 * provider mounted once in the app's layout, and a dialog only watches.
 * Anything on the page can add a batch (`enqueue`): each item brings the
 * file and a `send` — the route and shape are the caller's — and the
 * queue runs a few at a time, reports progress per file, keeps what
 * failed and why, and lets a failed file be sent again. While anything
 * is still queued or uploading the browser asks before a reload or a
 * close (`beforeunload`); a navigation inside the app keeps this
 * provider mounted, so the sends just carry on and the title bar's
 * UploadIndicator (upload-indicator.tsx) shows them.
 *
 * A finished batch with nothing failed clears itself a few seconds
 * later; one with failures stays until dismissed, so the reasons can be
 * read. `onItem` fires as each file lands (a tree reloads the folder),
 * `onDone` once per batch.
 *
 * What the rows say at each step, which file goes next and when a batch
 * clears itself are upload-queue.model.ts; this file holds the files,
 * runs the sends and keeps the timers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  activeCount,
  clearsItself,
  isBatchFinished,
  nextQueued,
  queueReducer,
  thrownOutcome,
  type QueueAction,
  type UploadBatch,
  type UploadJob,
  type UploadOutcome,
} from './upload-queue.model';

export type { UploadBatch, UploadJob, UploadOutcome, UploadStatus } from './upload-queue.model';
export { batchProgress, isBatchFinished } from './upload-queue.model';

/** Sends one file; reports bytes as they go; stops when `signal` aborts. */
export type UploadSender = (
  file: File,
  report: (loaded: number, total: number) => void,
  signal: AbortSignal
) => Promise<UploadOutcome>;

export interface UploadItemInput {
  file: File;
  /** Where it goes, as the table shows it — a path in the checkout, say. */
  label: string;
  send: UploadSender;
}

export interface EnqueueInput {
  title: string;
  destination: string;
  items: UploadItemInput[];
  /** Files sent at once; 3 unless said. */
  concurrency?: number;
  /** A file finished, one way or the other. */
  onItem?: (job: UploadJob, batch: UploadBatch) => void;
  /** Every file in the batch finished. */
  onDone?: (batch: UploadBatch) => void;
}

export interface UploadQueue {
  batches: UploadBatch[];
  /** Files queued or uploading, across every batch. */
  active: number;
  enqueue: (input: EnqueueInput) => string;
  /** Send a failed (or cancelled) file again. */
  retry: (batchId: string, jobId: string) => void;
  /** Stop a batch: in-flight sends abort, queued ones never start. */
  cancel: (batchId: string) => void;
  /** Forget a finished batch. */
  dismiss: (batchId: string) => void;
}

const DEFAULT_CONCURRENCY = 3;
/** A batch that finished with nothing failed stays visible this long. */
const CLEAR_AFTER_MS = 4_000;

const UploadQueueContext = createContext<UploadQueue | null>(null);

let nextId = 0;
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

interface JobRuntime {
  file: File;
  send: UploadSender;
  controller: AbortController | null;
}

interface BatchRuntime {
  concurrency: number;
  onItem?: (job: UploadJob, batch: UploadBatch) => void;
  onDone?: (batch: UploadBatch) => void;
  /** Lanes running right now. */
  lanes: number;
  cancelled: boolean;
}

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  // The latest batches, for the runners — state lags a render behind.
  const batchesRef = useRef<UploadBatch[]>([]);
  const jobs = useRef(new Map<string, JobRuntime>());
  const runtimes = useRef(new Map<string, BatchRuntime>());
  const clearTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const apply = useCallback((action: QueueAction) => {
    batchesRef.current = queueReducer(batchesRef.current, action);
    setBatches(batchesRef.current);
  }, []);

  const dismiss = useCallback(
    (batchId: string) => {
      const timer = clearTimers.current.get(batchId);
      if (timer) clearTimeout(timer);
      clearTimers.current.delete(batchId);
      const batch = batchesRef.current.find((entry) => entry.id === batchId);
      for (const job of batch?.jobs ?? []) jobs.current.delete(job.id);
      runtimes.current.delete(batchId);
      apply({ type: 'dismissed', batchId });
    },
    [apply]
  );

  /** One lane: takes queued jobs of the batch until none are left. */
  const runLane = useCallback(
    async (batchId: string) => {
      const runtime = runtimes.current.get(batchId);
      if (!runtime) return;
      runtime.lanes += 1;
      try {
        for (;;) {
          if (runtime.cancelled) return;
          const batch = batchesRef.current.find((entry) => entry.id === batchId);
          const next = nextQueued(batch);
          if (!batch || !next) return;
          const job = jobs.current.get(next.id);
          if (!job) {
            apply({ type: 'lost', batchId, jobId: next.id });
            continue;
          }
          const controller = new AbortController();
          job.controller = controller;
          apply({ type: 'started', batchId, jobId: next.id });
          let outcome: UploadOutcome;
          try {
            outcome = await job.send(
              job.file,
              (loaded) => apply({ type: 'progressed', batchId, jobId: next.id, loaded }),
              controller.signal
            );
          } catch (error) {
            outcome = thrownOutcome(error);
          }
          job.controller = null;
          apply({
            type: 'finished',
            batchId,
            jobId: next.id,
            outcome,
            aborted: controller.signal.aborted,
          });
          const after = batchesRef.current.find((entry) => entry.id === batchId);
          const finished = after?.jobs.find((entry) => entry.id === next.id);
          if (after && finished) runtime.onItem?.(finished, after);
        }
      } finally {
        runtime.lanes -= 1;
        if (runtime.lanes === 0) {
          const batch = batchesRef.current.find((entry) => entry.id === batchId);
          if (batch && isBatchFinished(batch)) {
            runtime.onDone?.(batch);
            if (clearsItself(batch)) {
              const timer = setTimeout(() => dismiss(batchId), CLEAR_AFTER_MS);
              clearTimers.current.set(batchId, timer);
            }
          }
        }
      }
    },
    [apply, dismiss]
  );

  const enqueue = useCallback(
    (input: EnqueueInput): string => {
      const batchId = id('batch');
      const items = input.items.map((item) => ({ item, jobId: id('job') }));
      for (const { item, jobId } of items) {
        jobs.current.set(jobId, { file: item.file, send: item.send, controller: null });
      }
      const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
      runtimes.current.set(batchId, {
        concurrency,
        onItem: input.onItem,
        onDone: input.onDone,
        lanes: 0,
        cancelled: false,
      });
      apply({
        type: 'enqueued',
        id: batchId,
        title: input.title,
        destination: input.destination,
        startedAt: Date.now(),
        jobs: items.map(({ item, jobId }) => ({
          id: jobId,
          name: item.file.name,
          size: item.file.size,
          label: item.label,
        })),
      });
      for (let lane = 0; lane < Math.min(concurrency, items.length); lane += 1) {
        void runLane(batchId);
      }
      return batchId;
    },
    [apply, runLane]
  );

  const retry = useCallback(
    (batchId: string, jobId: string) => {
      const runtime = runtimes.current.get(batchId);
      if (!runtime) return;
      runtime.cancelled = false;
      const timer = clearTimers.current.get(batchId);
      if (timer) clearTimeout(timer);
      apply({ type: 'retried', batchId, jobId });
      if (runtime.lanes < runtime.concurrency) void runLane(batchId);
    },
    [apply, runLane]
  );

  const cancel = useCallback(
    (batchId: string) => {
      const runtime = runtimes.current.get(batchId);
      if (runtime) runtime.cancelled = true;
      const batch = batchesRef.current.find((entry) => entry.id === batchId);
      for (const job of batch?.jobs ?? []) {
        if (job.status === 'uploading') jobs.current.get(job.id)?.controller?.abort();
      }
      apply({ type: 'cancelled', batchId });
    },
    [apply]
  );

  const active = useMemo(() => activeCount(batches), [batches]);

  // Leaving the page would drop every send still running.
  useEffect(() => {
    if (active === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers read the return value; newer ones show their own text.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);

  const value = useMemo<UploadQueue>(
    () => ({ batches, active, enqueue, retry, cancel, dismiss }),
    [batches, active, enqueue, retry, cancel, dismiss]
  );
  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}

/** The queue; throws outside the provider, which the app's layout mounts. */
export function useUploadQueue(): UploadQueue {
  const queue = useContext(UploadQueueContext);
  if (!queue) throw new Error('useUploadQueue needs an UploadQueueProvider above it.');
  return queue;
}

/** The queue, or null where no provider is mounted (a page outside the app's layout). */
export function useOptionalUploadQueue(): UploadQueue | null {
  return useContext(UploadQueueContext);
}
