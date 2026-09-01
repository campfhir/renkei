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
- **Run item**: OCRs each file in a group, in order, via Mistral (one call per FILE — OCR 4 paginates internally and bills per page regardless, so pre-splitting a multi-page PDF into page images would be pure waste), concatenates the pages into one assembled document, and stages it as `{documentKey}.md` in the sandbox, tagged with the batch's `batchId`.

## Where a batch lives afterward

Nothing here files anything into OnBase. The finished, assembled documents sit in the sandbox (`sandbox_list_files({batchId})`) for whatever agent the user points at that batch to read (`sandbox_read_file`) and act on — classification, keyword extraction, `onbase_archive_document`. That boundary is deliberate: this framework's job is turning "a folder of documents" into "readable text, one file per document," not deciding what happens to them.
