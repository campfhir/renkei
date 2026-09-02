/**
 * The catalog's own invariants — the ones a new entry can break without
 * any single call site noticing: ids unique and shaped `${source}/${type}`,
 * every filter comparing a key the event actually provides, every select
 * offering the empty "any" choice. Plus the batch-job events' semantics,
 * since those filters are what turns "run when any batch finishes" into
 * "run when an OCR batch fails".
 */

import { TRIGGER_EVENT_CATALOG, matchesTriggerEvent, triggerEventById } from './trigger-catalog';
import { normalizeMatch, describeFilters } from './trigger-filters';

describe('catalog invariants', () => {
  it('has unique ids of the form source/type', () => {
    const ids = TRIGGER_EVENT_CATALOG.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of TRIGGER_EVENT_CATALOG) {
      expect(event.id).toBe(`${event.source}/${event.type}`);
    }
  });

  it('only filters on keys the event provides', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      const provided = new Set(event.provides.map((entry) => entry.name.replace(/^trigger\./, '')));
      for (const field of event.filters) {
        expect({
          event: event.id,
          filter: field.id,
          key: field.payloadKey,
          ok: provided.has(field.payloadKey),
        }).toEqual({ event: event.id, filter: field.id, key: field.payloadKey, ok: true });
      }
    }
  });

  it('gives every select filter an empty "any" choice', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      for (const field of event.filters) {
        if (field.input !== 'select') continue;
        expect(field.options?.some((option) => option.value === '')).toBe(true);
      }
    }
  });

  it('prefixes every provided variable with trigger.', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      for (const entry of event.provides) {
        expect(entry.name.startsWith('trigger.')).toBe(true);
        expect(entry.source).toBe('trigger');
      }
    }
  });
});

describe('batch/job.completed', () => {
  const completed = (over: Record<string, unknown> = {}) => ({
    batchId: 'batch-1',
    name: 'Nightly scans',
    kind: 'document-ocr-pipeline',
    kindLabel: 'Document OCR pipeline',
    scheduleId: '',
    status: 'succeeded',
    total: 42,
    succeeded: 42,
    failed: 0,
    summary: 'OCR’d 42 documents',
    error: '',
    ...over,
  });

  it('exists, alongside batch/job.started, under the batch-jobs connector', () => {
    expect(triggerEventById('batch/job.completed')?.connector).toBe('batch-jobs');
    expect(triggerEventById('batch/job.started')?.connector).toBe('batch-jobs');
  });

  it('fires on every finish when nothing is constrained', () => {
    expect(matchesTriggerEvent('batch/job.completed', {}, completed())).toBe(true);
    expect(matchesTriggerEvent('batch/job.completed', {}, completed({ status: 'failed' }))).toBe(
      true
    );
  });

  it('narrows to one outcome', () => {
    const failedOnly = { outcomes: 'failed' };
    expect(matchesTriggerEvent('batch/job.completed', failedOnly, completed())).toBe(false);
    expect(
      matchesTriggerEvent('batch/job.completed', failedOnly, completed({ status: 'failed' }))
    ).toBe(true);
    expect(
      matchesTriggerEvent('batch/job.completed', failedOnly, completed({ status: 'partial' }))
    ).toBe(false);
  });

  it('narrows to one kind of job', () => {
    const ocrOnly = { kinds: 'document-ocr-pipeline' };
    expect(matchesTriggerEvent('batch/job.completed', ocrOnly, completed())).toBe(true);
    expect(
      matchesTriggerEvent('batch/job.completed', ocrOnly, completed({ kind: 'future-kind' }))
    ).toBe(false);
  });

  it('narrows by a substring of the batch name, case-insensitively', () => {
    const nightly = normalizeMatch(triggerEventById('batch/job.completed')!.filters, {
      nameContains: 'NIGHTLY',
    });
    expect(matchesTriggerEvent('batch/job.completed', nightly, completed())).toBe(true);
    expect(
      matchesTriggerEvent('batch/job.completed', nightly, completed({ name: 'Ad-hoc run' }))
    ).toBe(false);
  });

  it('describes a combined filter as one sentence', () => {
    const fields = triggerEventById('batch/job.completed')!.filters;
    expect(describeFilters(fields, { kinds: 'document-ocr-pipeline', outcomes: 'failed' })).toBe(
      'for a document OCR pipeline and only when the batch failed'
    );
  });

  it('applies the same kind and name filters to batch/job.started', () => {
    const started = {
      batchId: 'b',
      name: 'Nightly scans',
      kind: 'document-ocr-pipeline',
      kindLabel: '',
      scheduleId: '',
    };
    expect(
      matchesTriggerEvent('batch/job.started', { kinds: 'document-ocr-pipeline' }, started)
    ).toBe(true);
    expect(matchesTriggerEvent('batch/job.started', { nameContains: 'weekly' }, started)).toBe(
      false
    );
  });
});
