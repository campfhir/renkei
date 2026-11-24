/**
 * The catalog's own invariants — the ones a new entry can break without
 * any single call site noticing: ids unique and shaped `${source}/${type}`,
 * every filter comparing a key the event actually provides, every select
 * offering the empty "any" choice. Plus the batch-job events' semantics,
 * since those filters are what turns "run when any batch finishes" into
 * "run when an OCR batch fails".
 */

import { TRIGGER_EVENT_CATALOG, matchesTriggerEvent, triggerEventById } from './trigger-catalog';
import { normalizeMatch, describeFilters, validateMatch } from './trigger-filters';

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

  it('gives every tick-several filter its choices, none of them empty, each with its word', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      for (const field of event.filters) {
        if (field.input !== 'choice-list') continue;
        expect(field.options?.length).toBeGreaterThan(1);
        expect(field.options?.every((option) => option.value && option.describe)).toBe(true);
        expect(field.describeOne).toContain('{value}');
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

describe('deployments/deployment.changed', () => {
  const ID = 'deployments/deployment.changed';
  const fields = triggerEventById(ID)?.filters ?? [];
  const change = (over: Record<string, unknown> = {}) => ({
    changeId: 'deployment:d1:failed',
    projectId: 'p1',
    project: 'Shop',
    repository: 'acme/shop',
    environment: 'production',
    status: 'failed',
    ...over,
  });

  it('wakes for every report when nothing is ticked', () => {
    expect(matchesTriggerEvent(ID, undefined, change({ status: 'started' }))).toBe(true);
    expect(matchesTriggerEvent(ID, normalizeMatch(fields, { statuses: [] }), change())).toBe(true);
  });

  it('wakes only for the outcomes ticked: failed alone, or failed and succeeded', () => {
    const failed = normalizeMatch(fields, { statuses: ['failed'] });
    expect(matchesTriggerEvent(ID, failed, change())).toBe(true);
    expect(matchesTriggerEvent(ID, failed, change({ status: 'succeeded' }))).toBe(false);
    expect(matchesTriggerEvent(ID, failed, change({ status: 'started' }))).toBe(false);

    const ended = normalizeMatch(fields, { statuses: ['failed', 'succeeded'] });
    expect(matchesTriggerEvent(ID, ended, change())).toBe(true);
    expect(matchesTriggerEvent(ID, ended, change({ status: 'succeeded' }))).toBe(true);
    expect(matchesTriggerEvent(ID, ended, change({ status: 'started' }))).toBe(false);
    expect(describeFilters(fields, ended)).toBe('when the deployment has failed or succeeded');
  });

  it('reads a filter saved as one status the same way', () => {
    expect(normalizeMatch(fields, { statuses: 'failed' })).toEqual({ statuses: ['failed'] });
  });

  it('can keep to one environment and one project, by name', () => {
    const match = normalizeMatch(fields, {
      statuses: ['failed'],
      environmentContains: 'prod',
      projectContains: 'shop',
    });
    expect(matchesTriggerEvent(ID, match, change())).toBe(true);
    expect(matchesTriggerEvent(ID, match, change({ environment: 'staging' }))).toBe(false);
    expect(matchesTriggerEvent(ID, match, change({ project: 'Billing' }))).toBe(false);
  });
});

describe('deployments/health.changed', () => {
  const ID = 'deployments/health.changed';
  const fields = triggerEventById(ID)?.filters ?? [];
  const change = (state: string, previous = 'healthy') => ({
    changeId: `health:p1:production:${state}:2026-11-24T10:00:00.000Z`,
    projectId: 'p1',
    project: 'Shop',
    environment: 'production',
    state,
    previous,
  });

  it('offers every state an application can be announced in, for now and for before', () => {
    const all = [
      'failed',
      'stopped',
      'error',
      'degraded',
      'late',
      'healthy',
      'starting',
      'stopping',
    ];
    for (const id of ['states', 'previousStates']) {
      const field = fields.find((each) => each.id === id);
      expect(field?.input).toBe('choice-list');
      expect(field?.options?.map((option) => option.value)).toEqual(all);
    }
  });

  it('wakes for every change when nothing is ticked', () => {
    expect(matchesTriggerEvent(ID, undefined, change('starting'))).toBe(true);
  });

  it('wakes only for the states ticked, so a start or a routine recovery costs nothing', () => {
    const match = normalizeMatch(fields, { states: ['failed', 'stopped', 'error'] });
    expect(matchesTriggerEvent(ID, match, change('failed'))).toBe(true);
    expect(matchesTriggerEvent(ID, match, change('stopped'))).toBe(true);
    expect(matchesTriggerEvent(ID, match, change('error'))).toBe(true);
    expect(matchesTriggerEvent(ID, match, change('late'))).toBe(false);
    expect(matchesTriggerEvent(ID, match, change('healthy', 'failed'))).toBe(false);
    expect(matchesTriggerEvent(ID, match, change('starting'))).toBe(false);
    expect(describeFilters(fields, match)).toBe(
      'when the application is failed, stopped or reporting an error'
    );
  });

  it('can wake only on a recovery: healthy now, after trouble', () => {
    const match = normalizeMatch(fields, {
      states: ['healthy'],
      previousStates: ['failed', 'stopped', 'late', 'error', 'degraded'],
    });
    expect(matchesTriggerEvent(ID, match, change('healthy', 'failed'))).toBe(true);
    expect(matchesTriggerEvent(ID, match, change('healthy', 'late'))).toBe(true);
    // Starting to healthy is an ordinary boot; a first check-in has no state before it.
    expect(matchesTriggerEvent(ID, match, change('healthy', 'starting'))).toBe(false);
    expect(matchesTriggerEvent(ID, match, change('healthy', ''))).toBe(false);
    expect(describeFilters(fields, match)).toBe(
      'when the application is healthy and it was failed, stopped, reporting an error, degraded or potentially failing before'
    );
  });

  it('drops a state nobody knows rather than narrowing on it, and says so when saving', () => {
    expect(normalizeMatch(fields, { states: ['exploded', 'failed'] })).toEqual({
      states: ['failed'],
    });
    expect(normalizeMatch(fields, { states: ['exploded'] })).toEqual({});
    expect(validateMatch(fields, { states: ['exploded'] })).toEqual([
      expect.stringContaining('An application state is one of'),
    ]);
    expect(validateMatch(fields, { states: ['failed', 'stopped'] })).toEqual([]);
  });
});
