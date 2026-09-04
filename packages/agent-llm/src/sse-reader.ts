/**
 * A minimal server-sent-events reader over a fetch body — the wire format
 * both provider streams use. Deliberately small: the two adapters are the
 * only consumers, and each parses the `data:` payloads itself.
 *
 * Framing per the spec: a message is the lines up to a blank line;
 * `event:` names it, `data:` lines are joined with newlines, `id:` is kept
 * for completeness, and a line starting with `:` is a comment (providers
 * send those as keepalives). A `\r\n` line ending is tolerated. Bytes are
 * decoded incrementally so a multi-byte character split across chunks
 * survives.
 *
 * `idleMs` bounds the gap between two chunks: a stream that goes silent
 * mid-answer (a proxy that swallowed the tail, a stalled upstream) would
 * otherwise hang the caller until the whole-call timeout, which for a
 * chat is minutes. The reader throws an `IdleTimeoutError` instead, and
 * the adapters map that to the `timeout` kind.
 */

export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
}

export class IdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`No data received for ${idleMs}ms`);
    this.name = 'IdleTimeoutError';
  }
}

function parseMessage(lines: string[]): SseEvent | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    // `retry` and unknown fields are ignored, per the spec.
  }
  if (data.length === 0 && event === null) return null;
  return { event, data: data.join('\n'), id };
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number | undefined
): Promise<ReadResult> {
  if (!idleMs) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IdleTimeoutError(idleMs)), idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  options: { idleMs?: number } = {}
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: string[] = [];
  try {
    for (;;) {
      const { done, value } = await readWithIdle(reader, options.idleMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const message = parseMessage(pending);
          pending = [];
          if (message) yield message;
        } else {
          pending.push(line);
        }
        newline = buffer.indexOf('\n');
      }
    }
    // A final message without its trailing blank line.
    buffer += decoder.decode();
    if (buffer) pending.push(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    const last = parseMessage(pending);
    if (last) yield last;
  } finally {
    // Releasing on an early exit (the consumer broke out, or threw) tells
    // fetch to drop the connection rather than keep draining it.
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
    reader.releaseLock();
  }
}
