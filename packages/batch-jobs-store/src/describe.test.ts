/**
 * The wording a person reads about a batch — in a notification, an email,
 * a trigger variable. Kind-aware: an OCR batch talks about documents; an
 * unknown kind falls back to items without inventing a label.
 */

import { batchKindLabel, describeBatchOutcome } from './describe';

const ocr = (over: Partial<Parameters<typeof describeBatchOutcome>[0]> = {}) => ({
  kind: 'document-ocr-pipeline',
  status: 'succeeded',
  total: 42,
  succeeded: 42,
  failed: 0,
  last_error: null,
  ...over,
});

describe('batchKindLabel', () => {
  it('names the OCR pipeline as a person would', () => {
    expect(batchKindLabel('document-ocr-pipeline')).toBe('Document OCR pipeline');
  });

  it('falls back to the raw kind rather than an empty label', () => {
    expect(batchKindLabel('future-kind')).toBe('future-kind');
  });
});

describe('describeBatchOutcome', () => {
  it('reads as a clean finish when nothing failed', () => {
    expect(describeBatchOutcome(ocr())).toBe('OCR’d 42 documents');
  });

  it('singularizes one document', () => {
    expect(describeBatchOutcome(ocr({ total: 1, succeeded: 1 }))).toBe('OCR’d 1 document');
  });

  it('carries both counts for a partial finish', () => {
    expect(describeBatchOutcome(ocr({ status: 'partial', succeeded: 40, failed: 2 }))).toBe(
      'OCR’d 40 of 42 documents, 2 failed'
    );
  });

  it('says so plainly when every item failed', () => {
    expect(describeBatchOutcome(ocr({ status: 'failed', succeeded: 0, failed: 42 }))).toBe(
      'all 42 documents failed'
    );
  });

  it('reports an empty discovery as nothing to process', () => {
    expect(describeBatchOutcome(ocr({ total: 0, succeeded: 0 }))).toBe(
      'found no documents to process'
    );
  });

  it('uses the error when the batch never got as far as its items', () => {
    expect(
      describeBatchOutcome(
        ocr({ status: 'failed', total: null, succeeded: 0, last_error: 'share unreachable' })
      )
    ).toBe('share unreachable');
    expect(describeBatchOutcome(ocr({ status: 'failed', total: null, succeeded: 0 }))).toBe(
      'stopped before any items were found'
    );
  });

  it('speaks of items, not documents, for a kind it does not know', () => {
    expect(
      describeBatchOutcome(ocr({ kind: 'future-kind', succeeded: 3, failed: 1, total: 4 }))
    ).toBe('processed 3 of 4 items, 1 failed');
  });
});
