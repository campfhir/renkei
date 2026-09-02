/**
 * The embedding provider's contract with an OpenAI-compatible endpoint, and
 * the vector literal pgvector receives.
 */

// embeddings.ts → connector-config → @renkei/db → kysely (ESM, unloadable
// under jest); the client itself never touches the database.
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { OpenAiCompatibleEmbeddings, vectorLiteral, parseMaxDistance } from './embeddings';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OpenAiCompatibleEmbeddings', () => {
  it('posts to /embeddings with the model and returns vectors in order', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      })
    );

    const provider = new OpenAiCompatibleEmbeddings(
      'https://llm.example.com/v1/',
      'key-1',
      'small'
    );
    const result = await provider.embed(['a', 'b']);

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.val).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://llm.example.com/v1/embeddings');
    const payload = JSON.parse(String(init?.body));
    expect(payload).toEqual({ model: 'small', input: ['a', 'b'] });
  });

  it('fails on a non-2xx response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(429, { error: 'rate' }));
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm');
    expect((await provider.embed(['a'])).ok).toBe(false);
  });

  it('fails when the response has the wrong number of embeddings', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { data: [{ embedding: [1] }] }));
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm');
    expect((await provider.embed(['a', 'b'])).ok).toBe(false);
  });

  it('returns no vectors for no texts without calling the endpoint', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm');
    const result = await provider.embed([]);
    if (result.ok) expect(result.val).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an abort signal so a hung endpoint cannot block forever', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { data: [{ embedding: [1] }] }));
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm');
    await provider.embed(['a']);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout distinctly from an unreachable endpoint', async () => {
    // AbortSignal.timeout rejects the fetch with an error named
    // 'TimeoutError' — the same discriminator the connector clients use.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    );
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm', {
      timeoutMs: 15_000,
    });
    const result = await provider.embed(['a']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.message).toBe('embeddings endpoint timed out after 15000ms');
  });

  it('actually aborts: a never-resolving endpoint returns within the configured bound', async () => {
    // The stub resolves only when the signal it was handed aborts — proof
    // the timeout wiring reaches fetch, not just that a signal exists.
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('The operation was aborted due to timeout'), {
                name: 'TimeoutError',
              })
            )
          );
        })
    );
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm', {
      timeoutMs: 25,
    });
    const started = Date.now();
    const result = await provider.embed(['a']);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('vectorLiteral', () => {
  it('formats the pgvector input form', () => {
    expect(vectorLiteral([0.1, -2, 3])).toBe('[0.1,-2,3]');
    expect(vectorLiteral([])).toBe('[]');
  });
});

describe('instruction prefixes', () => {
  function capturedInput(fetchMock: jest.SpyInstance): unknown {
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    return typeof body === 'string' ? JSON.parse(body).input : undefined;
  }

  it('prefixes by purpose, verbatim, trailing space included', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { data: [{ embedding: [0.1] }] }));
    const provider = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm', {
      queryPrefix: 'query: ',
      passagePrefix: 'passage: ',
    });

    await provider.embed(['printers'], 'query');
    expect(capturedInput(fetchMock)).toEqual(['query: printers']);

    fetchMock.mockClear();
    await provider.embed(['the manual'], 'passage');
    expect(capturedInput(fetchMock)).toEqual(['passage: the manual']);
  });

  it('defaults to the passage side, and to no prefix at all', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { data: [{ embedding: [0.1] }] }));
    const bare = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm');
    await bare.embed(['text']);
    expect(capturedInput(fetchMock)).toEqual(['text']);

    fetchMock.mockClear();
    const prefixed = new OpenAiCompatibleEmbeddings('https://llm.example.com', 'k', 'm', {
      passagePrefix: 'passage: ',
    });
    await prefixed.embed(['text']);
    expect(capturedInput(fetchMock)).toEqual(['passage: text']);
  });
});

describe('parseMaxDistance', () => {
  it('accepts a finite positive number, as a number or a string', () => {
    expect(parseMaxDistance(0.55)).toBe(0.55);
    expect(parseMaxDistance('0.75')).toBe(0.75);
  });

  it('reads anything else as "no cutoff"', () => {
    for (const value of [undefined, null, '', 'abc', 0, -1, Number.NaN, {}]) {
      expect(parseMaxDistance(value)).toBeNull();
    }
  });
});
