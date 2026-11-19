import type { Json } from '../../../db.types';

/**
 * The pipeline builder's assistant answering one question in the
 * background (ci_assistant_jobs): owned by the person who asked, about one
 * code project. `step` is what it is doing now; `updatedAt` moves with
 * every write, the heartbeat a reader judges a silent job by.
 */
export interface CiAssistantJobRecord {
  id: string;
  subject: string;
  projectId: string;
  status: 'running' | 'succeeded' | 'failed';
  step: string | null;
  result: Json | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type CiAssistantJobOutcome =
  { status: 'succeeded'; result: Json } | { status: 'failed'; error: string };

export interface CiAssistantJobStore {
  /** Start one, running, at `at`; reads back as stored. */
  create(
    job: { id: string; subject: string; projectId: string; step: string | null },
    at: Date
  ): Promise<CiAssistantJobRecord>;
  /** One of this person's jobs; null when it is not theirs or does not exist. */
  find(subject: string, id: string): Promise<CiAssistantJobRecord | null>;
  /** Say what a running job is doing now (its heartbeat); false when it is no longer running. */
  progress(id: string, step: string, at: Date): Promise<boolean>;
  /** End a running job; false when it had ended already (or does not exist). */
  finish(id: string, outcome: CiAssistantJobOutcome, at: Date): Promise<boolean>;
  /** Retention: delete every job created before `before`, whatever its status; how many went. */
  pruneBefore(before: Date): Promise<number>;
}
