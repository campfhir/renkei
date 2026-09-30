import { parseQueue } from './queued-sends';

const file = {
  id: 'a1',
  filename: 'notes.txt',
  contentType: 'text/plain',
  sizeBytes: 12,
  extractStatus: 'done',
};

describe('parseQueue', () => {
  it('keeps messages and compaction requests in order', () => {
    const queue = [
      { id: 1, kind: 'message', input: { text: 'hi', attachments: [file], voice: true } },
      { id: 2, kind: 'compact' },
    ];
    expect(parseQueue(queue)).toEqual(queue);
  });

  it('drops unknown fields and a false voice flag', () => {
    expect(
      parseQueue([{ id: 1, kind: 'message', input: { text: 'x', attachments: [], extra: 1 } }])
    ).toEqual([{ id: 1, kind: 'message', input: { text: 'x', attachments: [] } }]);
  });

  it('refuses anything malformed', () => {
    expect(parseQueue('nope')).toBeNull();
    expect(parseQueue([{ id: '1', kind: 'compact' }])).toBeNull();
    expect(parseQueue([{ id: 1, kind: 'other' }])).toBeNull();
    expect(
      parseQueue([{ id: 1, kind: 'message', input: { text: 1, attachments: [] } }])
    ).toBeNull();
    expect(
      parseQueue([{ id: 1, kind: 'message', input: { text: 'x', attachments: [{ id: 'a' }] } }])
    ).toBeNull();
  });
});
