import { readOperationView } from './operation-view';

describe('an operation as the browser receives it', () => {
  it('reads every field the page shows', () => {
    expect(
      readOperationView({
        id: 'op-1',
        kind: 'notebook-definition',
        workspaceId: 'ws',
        workspaceName: 'Sales',
        itemId: 'nb',
        itemName: 'Load orders',
        format: 'ipynb',
        status: 'succeeded',
        percentComplete: 100,
        error: null,
        parts: [
          { path: 'notebook-content.ipynb', text: '{}' },
          { path: 'logo.png', text: null },
        ],
        createdAt: '2026-11-19T00:00:00.000Z',
        finishedAt: '2026-11-19T00:01:00.000Z',
        nextPollAt: null,
      })
    ).toMatchObject({
      status: 'succeeded',
      parts: [
        { path: 'notebook-content.ipynb', text: '{}' },
        { path: 'logo.png', text: null },
      ],
    });
  });

  it('is nothing when it is not an operation', () => {
    expect(readOperationView('<html>')).toBeNull();
    expect(readOperationView({ id: 'op', kind: 'report', status: 'running' })).toBeNull();
    expect(readOperationView({ id: 'op', kind: 'notebook-definition', status: 'done' })).toBeNull();
  });
});
