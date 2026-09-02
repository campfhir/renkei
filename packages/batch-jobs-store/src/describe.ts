/**
 * Human wording for a batch, shared by everything that has to say the same
 * thing about one: the owner's notification (apps/worker writes it), the
 * `batch/job.*` trigger events an agent reads, and the web pages. One
 * source, so "OCR’d 40 of 42 documents" reads identically in a toast, an
 * email and a trigger variable.
 *
 * Kind-aware on purpose. A kind is a string in the database and a handler
 * in the worker; the only thing a PERSON should ever see is its label and
 * what its items are called — a document-ocr-pipeline processes documents,
 * a future kind may process something else. Both live here, beside the
 * kind name constants, so adding a kind is one entry.
 */

import { DOCUMENT_OCR_PIPELINE_KIND } from './kind-names';

interface KindWording {
  label: string;
  /** The noun for one item, and for several. */
  item: [singular: string, plural: string];
  /** What running an item did to it, past tense — "OCR’d", "processed". */
  verb: string;
}

const KIND_WORDING: Record<string, KindWording> = {
  [DOCUMENT_OCR_PIPELINE_KIND]: {
    label: 'Document OCR pipeline',
    item: ['document', 'documents'],
    verb: 'OCR’d',
  },
};

const GENERIC_WORDING: KindWording = {
  label: '',
  item: ['item', 'items'],
  verb: 'processed',
};

/** 'Document OCR pipeline' for a known kind; the raw kind string otherwise. */
export function batchKindLabel(kind: string): string {
  return KIND_WORDING[kind]?.label || kind;
}

function wordingOf(kind: string): KindWording {
  return KIND_WORDING[kind] ?? GENERIC_WORDING;
}

function plural(count: number, [one, many]: [string, string]): string {
  return count === 1 ? one : many;
}

/**
 * One sentence fragment for what a batch did — "OCR’d 40 of 42 documents,
 * 2 failed", "OCR’d 12 documents", "found nothing to process", or, for a
 * batch that never got as far as its items, the error itself. Never ends
 * in a period so a caller can put it after a colon.
 */
export function describeBatchOutcome(batch: {
  kind: string;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  skipped?: number;
  last_error: string | null;
}): string {
  const wording = wordingOf(batch.kind);
  if (batch.total === null) {
    // Failed before discovery finished: the error is the whole story.
    return batch.last_error ?? 'stopped before any items were found';
  }
  if (batch.total === 0) return `found no ${wording.item[1]} to process`;
  const skipped = batch.skipped ?? 0;
  const attempted = batch.total - skipped;
  // "40 already processed" reads the same after every outcome, so it is
  // one suffix rather than a phrase per branch.
  const alreadyDone = skipped > 0 ? `, ${skipped} already processed` : '';
  if (attempted === 0) {
    return `all ${batch.total} ${plural(batch.total, wording.item)} were already processed`;
  }
  const noun = plural(attempted, wording.item);
  if (batch.failed === 0) return `${wording.verb} ${attempted} ${noun}${alreadyDone}`;
  if (batch.succeeded === 0) return `all ${attempted} ${noun} failed${alreadyDone}`;
  return `${wording.verb} ${batch.succeeded} of ${attempted} ${noun}, ${batch.failed} failed${alreadyDone}`;
}
