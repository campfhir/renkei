import type { FabricOperationView } from '@/lib/fabric/operation-view';
import {
  POLL_MS,
  STREAM_FAILURES_BEFORE_POLLING,
  downloadName,
  headline,
  initialOperation,
  operationReducer,
  partTabs,
  progressLine,
  readPart,
  selectedPart,
  type OperationAction,
  type OperationState,
} from './operation-view.model';

const IPYNB = JSON.stringify({
  nbformat: 4,
  cells: [
    { cell_type: 'markdown', source: ['# Orders'] },
    { cell_type: 'code', source: ['df = spark.read.table("orders")'] },
  ],
});

const running: FabricOperationView = {
  id: 'op-1',
  kind: 'notebook-definition',
  workspaceId: 'ws',
  workspaceName: 'Sales',
  itemId: 'nb',
  itemName: 'Load orders',
  format: 'ipynb',
  status: 'running',
  percentComplete: null,
  error: null,
  parts: [],
  createdAt: '2026-11-17T12:00:00.000Z',
  finishedAt: null,
  nextPollAt: '2026-11-17T12:00:30.000Z',
};
const succeeded: FabricOperationView = {
  ...running,
  status: 'succeeded',
  percentComplete: 100,
  finishedAt: '2026-11-17T12:01:00.000Z',
  nextPollAt: null,
  parts: [
    { path: '.platform', text: '{"metadata":{}}' },
    { path: 'notebook-content.ipynb', text: IPYNB },
  ],
};

const fold = (start: FabricOperationView, ...actions: OperationAction[]): OperationState =>
  actions.reduce(operationReducer, initialOperation(start));

describe('the operation page', () => {
  it('listens on the stream while Fabric works, and says the person may leave', () => {
    const state = fold(running, { type: 'update', operation: { ...running, percentComplete: 40 } });
    expect(state.transport).toBe('stream');
    expect(headline(state)).toBe("Fabric is preparing the notebook's definition…");
    expect(progressLine(state)).toBe(
      '40% · this page updates the moment it is ready. You can leave — you will be notified when it is ready.'
    );
  });

  it('stops listening the moment the definition arrives, and opens the notebook first', () => {
    const state = fold(running, { type: 'update', operation: succeeded });
    expect(state.transport).toBe('closed');
    expect(headline(state)).toBe("The notebook's definition is ready.");
    expect(progressLine(state)).toBeNull();
    expect(partTabs(state)).toEqual(['notebook-content.ipynb', '.platform']);
    expect(selectedPart(state)?.path).toBe('notebook-content.ipynb');
  });

  it('a late "running" never undoes an end', () => {
    const state = fold(
      running,
      { type: 'update', operation: succeeded },
      { type: 'update', operation: running }
    );
    expect(state.operation.status).toBe('succeeded');
  });

  it('a page opened on a finished operation never listens at all', () => {
    expect(initialOperation(succeeded).transport).toBe('closed');
  });

  it(`falls back to polling every ${POLL_MS / 1000}s after ${STREAM_FAILURES_BEFORE_POLLING} stream failures in a row`, () => {
    const once = fold(running, { type: 'streamFailed' });
    expect(once.transport).toBe('stream');
    const recovered = fold(
      running,
      { type: 'streamFailed' },
      { type: 'streamOpened' },
      { type: 'streamFailed' }
    );
    expect(recovered.transport).toBe('stream');
    const polling = fold(running, { type: 'streamFailed' }, { type: 'streamFailed' });
    expect(polling.transport).toBe('polling');
    expect(progressLine(polling)).toMatch(/^checking every few seconds\./);
  });

  it('a failure says what Fabric said', () => {
    const state = fold(running, {
      type: 'update',
      operation: { ...running, status: 'failed', error: 'Label blocks export', nextPollAt: null },
    });
    expect(headline(state)).toBe("Fabric could not give the notebook's definition.");
    expect(state.operation.error).toBe('Label blocks export');
    expect(state.transport).toBe('closed');
  });

  it('reads a notebook as its cells, a pipeline as its activities', () => {
    expect(readPart({ path: 'notebook-content.ipynb', text: IPYNB })).toEqual({
      kind: 'notebook',
      cells: [
        { kind: 'markdown', source: '# Orders' },
        { kind: 'code', source: 'df = spark.read.table("orders")' },
      ],
    });
    const json = JSON.stringify({ properties: { activities: [{ name: 'Copy', type: 'Copy' }] } });
    expect(readPart({ path: 'pipeline-content.json', text: json })).toEqual({
      kind: 'pipeline',
      activities: [{ name: 'Copy', type: 'Copy', dependsOn: [] }],
      json,
    });
    expect(readPart({ path: '.platform', text: '{}' })).toEqual({ kind: 'text', text: '{}' });
  });

  it('another part can be opened, but not one the definition does not have', () => {
    const state = fold(
      running,
      { type: 'update', operation: succeeded },
      { type: 'partChosen', path: '.platform' }
    );
    expect(selectedPart(state)?.path).toBe('.platform');
    expect(operationReducer(state, { type: 'partChosen', path: 'nope' })).toBe(state);
  });

  it('a download is named after the notebook', () => {
    const state = fold(succeeded);
    expect(downloadName(state, 'notebook-content.ipynb')).toBe('Load orders.ipynb');
  });
});
