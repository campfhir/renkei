/**
 * The reader's promises: framing survives arbitrary chunk boundaries
 * (including a multi-byte character split in two), multi-line data joins
 * with newlines, comments are dropped, and a silent stream is reported as
 * idle rather than waited on forever.
 */

import { IdleTimeoutError, readSseEvents, type SseEvent } from './sse-reader';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, idleMs?: number): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of readSseEvents(stream, { idleMs })) out.push(event);
  return out;
}

describe('readSseEvents', () => {
  it('parses event and data fields split across chunks', async () => {
    const events = await collect(
      streamOf(['event: message_st', 'art\ndata: {"a":', '1}\n\nevent: ping\ndata: {}\n\n'])
    );
    expect(events).toEqual([
      { event: 'message_start', data: '{"a":1}', id: null },
      { event: 'ping', data: '{}', id: null },
    ]);
  });

  it('joins multi-line data, drops comments, tolerates CRLF and a missing final blank line', async () => {
    const events = await collect(
      streamOf([': keepalive\r\ndata: one\r\ndata: two\r\n\r\ndata: last'])
    );
    expect(events).toEqual([
      { event: null, data: 'one\ntwo', id: null },
      { event: null, data: 'last', id: null },
    ]);
  });

  it('decodes a multi-byte character split between chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\n');
    const cut = 8; // inside the two-byte "é"
    const events = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(events[0].data).toBe('héllo');
  });

  it('throws IdleTimeoutError when no chunk arrives within idleMs', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueues, never closes.
      },
    });
    await expect(collect(stream, 20)).rejects.toBeInstanceOf(IdleTimeoutError);
  });
});
