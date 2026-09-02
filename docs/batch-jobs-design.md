# Batch jobs — design

As-built. `batch_jobs`/`batch_job_items` is a generic, kind-dispatched framework for "do the same thing to a large number of items and track progress" — modeled on `mail_bulk_jobs` (migration 046) but changed in one load-bearing way: **items fan out across the queue individually**, not inside one handler's loop. `document-ocr-pipeline` is the first kind; a future batch job type is a new handler registered against a new kind, no schema change.

## Why this exists, and why not the agent-run engine

The motivating use case is a document pipeline: pull potentially thousands of files off a network share, OCR each one, and file the results into OnBase. The first instinct was to build this as a chain of Renkei "agents" (the LLM step-tree kind, `agent_runs`) — split, OCR, group, file, each its own agent, fanned out per document. The actual limits in that engine rule that out:

- A `loop` step caps at **25 iterations** (`MAX_LOOP_ITERATIONS`, `packages/agents/src/steps.ts`), and a loop's collected results cap at **100 items** — nowhere near "thousands."
- An agent **cannot** spawn a child run per item. `agent_run_now` is explicitly refused when called from inside a running agent; the sanctioned mechanism is a fixed trigger edge (`kind: 'agent'`), fired once, fire-and-forget, capped at chain depth 3 and an org-wide **200 runs/day**.

So the shape here splits by what actually needs an LLM: splitting pages, OCR, and grouping are mechanical — no judgment call anywhere in them — and become this batch-job framework, no agent involved. Only "given this document's OCR text, what's the OnBase document type and field values" is genuinely agentic, and that stays exactly what it already was: a normal Renkei agent the user authors, fed one finished document at a time by reading it out of the sandbox (`sandbox_list_files` filtered by `batchId`, then `sandbox_read_file`).

## Why per-item fan-out, not a `mail_bulk_jobs`-style loop

`mail_bulk_jobs` executes an entire job inside one queue delivery, batching fast calls (Microsoft Graph, 20 at a time) up to a hard **1,000-item** ceiling. OCR calls are the opposite shape: slow, external, one call per document, and "thousands of documents" needs to run across many worker instances at once, not serially inside one handler.

So `batch_job_messages` (migration 077, `packages/queue`'s `batchJobsQueue()`) carries one message per unit of work:

- **`discover`** — one message per batch. Lists/groups the source into items, creates their `batch_job_items` rows, and enqueues one `item` message per item.
- **`item`** — one message per item. Runs the batch's kind handler on it and records the outcome.

Both ride the same row-locked `FOR UPDATE SKIP LOCKED` claim mechanism every other Renkei queue uses, so `worker-batch-jobs` scales horizontally the same way `embeddings-worker`/`worker-agents` do. Messages are tagged `source: batch:{batchJobId}` — the `embedding_jobs` provider-lane precedent applied per batch instead of per connector, so one 5,000-item batch can't starve a smaller concurrent one.

## Crash recovery: never silently re-run billed work

Two guards, both the `mail_bulk_jobs` single-effective-attempt pattern applied at finer grain (`packages/batch-jobs-store/src/store.ts`):

- A batch found `discovering` on redelivery means a previous attempt died mid-discovery. It is **not** re-run — that would create duplicate items — it finalizes as `failed`, and starting over is a fresh batch.
- An item found `processing` on redelivery means a previous attempt died mid-item. It is **not** re-run either: OCR is billed per call, so a blind retry double-charges. It finalizes as `failed` and rolls into the batch's counters like any other failure.

## Completion is a distributed counter

Items finish concurrently, potentially across many worker instances, so `recordItemOutcome` never does read-then-write: it increments `succeeded`/`failed` with one atomic `UPDATE ... RETURNING`, and the terminal-status flip is guarded by `WHERE status = 'running'` — only the one caller whose completion actually reaches the total wins that race; every other concurrent finisher's identical `UPDATE` affects zero rows.

## document-ocr-pipeline

- **Discover** (`apps/worker/src/batch-jobs/document-ocr-pipeline.ts`): lists the configured fileshare folder and groups files by the batch's chosen strategy — `{strategy: "whole-file"}` (one file = one document) or `{strategy: "filename-pattern", pattern}` (a regex with named captures `documentKey`/`page`, for a scanner's per-page dump). A file the pattern can't parse becomes its own single-file group rather than being silently dropped.
- **Run item**: reads every file in the group, hashes it against the ledger (below), then OCRs each file in order via Mistral (one call per FILE — OCR 4 paginates internally and bills per page regardless, so pre-splitting a multi-page PDF into page images would be pure waste), concatenates the pages into one assembled document, and stages it as `{documentKey}.md` in the sandbox, tagged with the batch's `batchId`.

## Never the same file twice: the processed-files ledger

A folder scanned nightly still holds last night's files, so `document-ocr-pipeline` keeps a ledger — `batch_processed_files` (migration 089, `packages/batch-jobs-store/src/processed-files.ts`) — keyed by the **SHA-256 of a file's bytes**, scoped to (tenant, share). Whether a file is "already done" is a hash comparison, never a judgement a model makes. On by default (`config.skipProcessed`, opt-out), checked twice, each time before anything billed:

1. **At discovery, from the listing alone.** The ledger also records the path/size/modified-time triple the file had when it was hashed; a listed file whose triple matches is skipped without being read. Recorded as an item with status `skipped` (so the batch page lists it under a Skipped tab with its reason) and never enqueued. `matchesProcessedStat` is that comparison, pure and unit-tested; anything unsure — no modified time on either side — falls through rather than skipping on a guess.
2. **At item time, after the read OCR needs anyway.** Every file in the group is read and hashed; if every hash is in the ledger the item ends as `skipped` before the Mistral call. This is what catches a re-copied or renamed file. One new page in a multi-file document means the whole document is assembled again.

After a document is staged, its files are upserted into the ledger on the hash (rewriting the triple, so the fast path follows a file that moved). The write is best-effort: a lost ledger write costs one repeat later, not the document now. Opting out means the ledger is neither read nor written by that batch — "keep no record", so an opted-out batch can never make a later opted-in one skip files it never saw processed.

`skipped` is a third counter on `batch_jobs` beside `succeeded`/`failed` and a third terminal item status. It counts against `total` for the completion flip (`activateBatch` can now itself be the terminal transition, when every enqueued item beat it) and appears everywhere the other two do — progress lines, `describeBatchOutcome` ("OCR'd 2 documents, 40 already processed"), the owner's notification, and `trigger.skipped` on `batch/job.completed` — but never decides the batch's status: skipped items neither help nor hurt.

## What happens to the source afterwards

Opt-in, per batch or schedule (`config.afterProcessing`, default `{action: "keep"}`): `{action: "delete"}` removes each source file once its document is staged; `{action: "move", shareId, path}` moves it to a folder — on the same share (a server-side rename via `fsMoveEntry`) or on another one (write the bytes already in hand to the destination with `fsWriteFile`, then remove the source; the destination is probed first and an existing file is refused, never overwritten). SMB versus SFTP never reaches this code: `@renkei/fileshares-client` is the whole surface, and the fileshare worker owns the protocols.

A post-processing failure **fails the item**, with the staged sandbox file id still in its result and the ledger already holding the hash: the OCR is done and paid for and a rerun skips it, but the batch's contract — process AND move — was not met, and that belongs in the batch's `partial` status and the owner's notification rather than behind a clean finish.

**Consent.** Moving or deleting on a share is exactly what a connection's "write tools" / "delete tools" choices on the Connectors page cover, so a batch may only do to a share what its owner already allowed the tools to do there — checked by `afterProcessingRefusal` (`apps/web/lib/batch-jobs/pipeline-options.ts`) on every start path (the REST route, both schedule routes, and the `batch_start_document_pipeline` MCP tool) when the batch or schedule is created. The file server still judges every operation with the owner's own credentials at run time; the worker's I/O path reads no exposure flag, same as every other fileshare operation. The forms grey the options out and say why before the click.

## Where a batch lives afterward

Nothing here files anything into OnBase. The finished, assembled documents sit in the sandbox (`sandbox_list_files({batchId})`) for whatever agent the user points at that batch to read (`sandbox_read_file`) and act on — classification, keyword extraction, `onbase_archive_document`. That boundary is deliberate: this framework's job is turning "a folder of documents" into "readable text, one file per document," not deciding what happens to them.

## Naming

Every batch has a `name` (`batch_jobs.name`, required, `varchar(200)`) — added in migration 078 once schedules made `kind` + a timestamp genuinely ambiguous: a nightly schedule produces one `document-ocr-pipeline` batch after another, and "which one was this again" stopped being answerable from the list. Both start paths (`batch_start_document_pipeline` and the web form) require it; there is no default beyond the DB column's `'Untitled batch'`, which exists only so the column can be added `NOT NULL` against pre-migration rows, never a name a live caller is expected to see.

## Scheduling

`batch_job_schedules` (migration 078, `packages/batch-jobs-store/src/schedules.ts`) is the recipe a recurring batch is defined once against — the `agents`/`agent_triggers` split applied to batch jobs, but flattened: one schedule always produces the same kind of batch (no event/api/agent-chaining trigger kinds, just "run it once" vs. "run it on a schedule"), so there is no separate "definition" object beyond the schedule row itself. A schedule carries the same `name`/`kind`/`config` shape a one-off batch does, plus a `schedule_config` (a serialized `ScheduleConfig`, `packages/agents/src/recurrence.ts`) and the `enabled`/`next_run_at`/`last_fired_at`/`last_error` bookkeeping `agent_triggers` already established.

**Recurrence math is not reimplemented.** `ScheduleConfig`, `parseScheduleConfig`, `computeNextRunForSchedule`, and `blackoutPredicate` are `@renkei/agents` exports, reused as-is — structured rules (hour/day/week/month, with an org holiday calendar and per-schedule blackout dates), no cron. `packages/batch-jobs-store` itself stays dependency-light on purpose (the `connector-*` precedent: no `@renkei/agents` import), so `schedules.ts` is CRUD only — every caller owns parsing/serializing `ScheduleConfig` and passes `nextRunAt` in, already computed.

**Firing** (`apps/worker/src/batch-jobs/schedule-sweep.ts`) is `apps/worker-agents/src/schedule-sweep.ts`'s exact pattern, adapted: a periodic sweep (`schedulePeriodicSweep`, 30s, its own timer independent of `batch-jobs-worker`'s queue-consumption loop) selects due rows (`enabled` and `next_run_at <= NOW()`, the partial index `idx_batch_job_schedules_due` covers exactly this), computes the next occurrence, and **advances the row under an optimistic lock** — `UPDATE ... SET next_run_at = next WHERE id = ? AND next_run_at = observed` — before doing anything else. Only the one sweep replica whose `UPDATE` actually changed a row goes on to fire; every other concurrent sweep's identical `UPDATE` affects zero rows and moves on. A lost race is silence, not an error — the same "advance-then-fire" discipline `agent_triggers` uses, verified here against a real database (`apps/worker/src/batch-jobs/schedule-sweep.test.ts`) including the two-sweeps-race-one-fire case.

Firing itself is **kind-generic**: the winning sweep just calls `createBatch` (name/kind/config carried straight over from the schedule) with `scheduleId` set, then `enqueueDiscover` — the exact same two calls a one-off start makes. Kind dispatch (`apps/worker/src/batch-jobs/kinds.ts`) picks up from there with no idea the batch came from a schedule; a future batch kind needs no schedule-sweep change.

A malformed `schedule_config` (should never happen — every write path validates through `parseScheduleConfig` first) or a config with no reachable next occurrence (every rule smothered by blackouts) disables the schedule with `last_error` set, rather than re-erroring every sweep pass forever.

## Announcing a batch: the owner, and agents

A batch has two audiences beyond its own row, and both are told from one place — `apps/worker/src/batch-jobs/lifecycle.ts`, called by the queue handlers at the moment a batch changes state:

- **The owner gets a notification.** `batch_jobs.subject` is the reader — for a scheduled batch that is whoever owns the schedule, because the sweep copies the schedule's subject into `createBatch`, so nothing downstream distinguishes a hand-started batch from a scheduled one. Three new `agent_notifications` kinds — `batch_started`, `batch_finished` (which includes `partial`), `batch_failed` — each gated at write time by its own preference (`batchStarted`/`batchFinished`/`batchFailed` in `@renkei/user-prefs`, defaults: started off, the other two on in the app, email/WebEx off; the Preferences page has a "Batch jobs" table for them). The row wears `connector: 'batch-jobs'`, `entity: 'batch'`, a headline built from `describeBatchOutcome` ("“Nightly scans” finished with failures: OCR’d 40 of 42 documents, 2 failed"), and — new with migration 088 — a `meta` jsonb column carrying the structured facts a headline can't: the batch id, kind and its label, name, status, total/succeeded/failed, the error, the schedule id and timestamps. That is what lets the feed say what KIND of job it was and link to the batch page (`apps/web/lib/notifications/batch-meta.ts` parses it back). App rows also push (`@renkei/notifications`); email and WebEx go through `apps/worker/src/handlers/owner-channels.ts`, the delivery arm factored out of the run-failed handler so a batch and a failed run reach Outlook/WebEx identically.
- **Agents get an event.** `batch/job.started` and `batch/job.completed` are entries in the trigger catalog (`packages/agents/src/trigger-catalog.ts`, connector `batch-jobs`), published as domain events on the `events` queue under the `domain:batch` lane (`publishDomainEvent`, provider `'batch'`) and dispatched by the interactive worker to `fanOutAgentEvents` like every other domain event — so only the owner's agents fire, and the trigger's deterministic filters apply first: kind of job (a fixed choice), outcome (`succeeded`/`partial`/`failed`), and a substring of the batch name. The completion event provides `trigger.batchId`, `name`, `kind`, `kindLabel`, `scheduleId`, `status`, `total`, `succeeded`, `failed`, `summary` and `error`; `batch/job.started` provides the identity half. This is the "OCR overnight, then file into OnBase" chain: an agent on `batch/job.completed` reads `sandbox_list_files({batchId: trigger.batchId})`, then `sandbox_read_file` each document and `onbase_archive_document` it. A fixated interactive worker (`WORKER_EVENT_SOURCES`) must list `batch` somewhere, or the `domain:batch` lane is never drained.

**Exactly once, inherited from the store.** Every terminal transition (`failBatch`, `completeEmptyBatch`, and `recordItemOutcome` when it wins the guarded flip) now resolves to the finalized row only for the one call that actually made the transition, and undefined for a redelivery or a concurrent finisher that lost — the same "only the winner sees a row" shape as `beginDiscovery`/`claimItem`. The handlers announce only when they hold a row, so a batch is never announced twice without a second lock. `beginDiscovery`'s claim is where "started" is announced, for the same reason.

**Best-effort, deliberately.** By the time an announcement runs the transition has happened, and a redelivery of the queue message would find the batch terminal and do nothing — so a failed publish or notification write cannot be retried by throwing; it would only lose the event later instead of now. Every step in `lifecycle.ts` is a WARN and carries on. The batch page is the record; this is reach. Agents are told before the owner: the event is the cheaper, more consequential half, and a chained agent should not queue behind a mail send.

## The web UI

Batches are also a plain part of the app for someone who would rather click than ask an agent — `apps/web/app/[slug]/batch-jobs/`:

- **List** (`page.tsx`) and **detail** (`[batchId]/page.tsx`) are server components that call `listBatches`/`getBatch`/`listItems` from `@renkei/batch-jobs-store` directly, the same "read your own tenant's data without an HTTP hop" pattern the agent-runs pages use — no separate REST surface exists for reading a batch's status. Both scope by `subject`, so a batch id alone is never an existence oracle for someone else's batch (a mismatched subject reads as "not found," matching `batch_get_job`). The detail page links back to the schedule that spawned a batch, when there is one.
- **New** (`new/page.tsx` + `new-batch-job-form.tsx`) is the one place that mutates: it POSTs to `apps/web/app/api/tenant/[tenantId]/batch-jobs/route.ts`, which validates the chosen share is one the caller has actually connected and the grouping shape is well-formed, then calls the same `startDocumentOcrPipeline` helper (`apps/web/lib/batch-jobs/start-document-ocr-pipeline.ts`) the `batch_start_document_pipeline` MCP tool calls — an agent and a human land on the identical `createBatch`+`enqueueDiscover` path, so the two starting points cannot drift. The share/folder/grouping fields (`source-fields.tsx`) are a fully-controlled component shared with the schedule forms below, so the two flows cannot drift on what's asked for either.
- **Schedules** (`schedules/page.tsx`, `schedules/new/`, `schedules/[scheduleId]/`) mirror the batch pages one level up: list/read hit `@renkei/batch-jobs-store` directly, create/edit/delete go through `apps/web/app/api/tenant/[tenantId]/batch-job-schedules/route.ts` (+ `[scheduleId]/route.ts`), which recomputes `next_run_at` server-side — via `apps/web/lib/batch-jobs/schedule-next-run.ts`, the same `computeNextRunForSchedule` + org-calendar lookup `agent_triggers`' reconcile does — whenever the recurrence changes or a disabled schedule is re-enabled, and leaves a merely-renamed or merely-disabled schedule's `next_run_at` untouched. The recurrence editor itself is not a new component: it's `ScheduleEditor` from the agent builder (`apps/web/app/[slug]/agents/builder/schedule-picker.tsx`), reused unmodified — it was already a pure `value`/`onChange` component over `ScheduleConfig` with no agent-specific state, so batch-job schedules needed nothing more than passing it the org's calendars (`apps/web/lib/schedule-calendars.ts`, factored out of the agent builder's own fetch for this second caller).

A future batch kind that wants its own "start" form adds a route + form the same way, still sharing whatever the kind's own `startXxx` helper turns out to be.
