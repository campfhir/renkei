import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  decodeDefinition,
  encodeDefinition,
  fabricPages,
  fabricRequest,
  mainPart,
  pendingOf,
  pollOperation,
  retryAfterOf,
  FabricRefusal,
  type FabricFetch,
} from './api';
import * as readable from './readable';
import { advanceIfDue, advanceOperation, startDefinitionOperation } from './operations';

const BASE = 'https://fabric.test/v1';
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 17, 12, 0, seconds));
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const NOTEBOOK = '{"cells":[{"cell_type":"code","source":["print(1)"]}]}';
const definitionBody = {
  definition: {
    format: 'ipynb',
    parts: [
      { path: 'notebook-content.ipynb', payload: b64(NOTEBOOK), payloadType: 'InlineBase64' },
      { path: '.platform', payload: b64('{"metadata":{}}'), payloadType: 'InlineBase64' },
    ],
  },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A Fabric that answers each request with the next reply for its path, recording calls. */
function fakeFabric(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetcher: FabricFetch = async (url, init) => {
    const path = url.replace(BASE, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const queue = routes[path];
    const reply = queue?.length ? (queue.length > 1 ? queue.shift() : queue[0]) : undefined;
    if (!reply) return new Response('{"errorCode":"NotFound"}', { status: 404 });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  };
  return { fetcher, calls };
}

const start = (fetcher: FabricFetch, now = at(0)) =>
  startDefinitionOperation({
    id: '00000000-0000-4000-8000-000000000001',
    subject: 'ann',
    kind: 'notebook-definition',
    workspaceId: 'ws1',
    workspaceName: 'Sales',
    itemId: 'nb1',
    itemName: 'Load orders',
    format: 'ipynb',
    fetcher,
    base: BASE,
    now,
  });

const GET_DEFINITION = '/workspaces/ws1/notebooks/nb1/getDefinition?format=ipynb';

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('reading Fabric answers', () => {
  it('reads a started operation from its headers, the id from Location when the header is missing', () => {
    const withHeader = new Response(null, {
      status: 202,
      headers: { 'x-ms-operation-id': 'op1', 'Retry-After': '30' },
    });
    expect(pendingOf(withHeader)).toEqual({ operationId: 'op1', retryAfterSeconds: 30 });
    const withLocation = new Response(null, {
      status: 202,
      headers: { Location: 'https://api.fabric.microsoft.com/v1/operations/op2' },
    });
    expect(pendingOf(withLocation)).toEqual({ operationId: 'op2', retryAfterSeconds: 5 });
    expect(pendingOf(new Response('{}', { status: 200 }))).toBeNull();
  });

  it('keeps Retry-After between one second and a minute', () => {
    expect(retryAfterOf(new Headers({ 'Retry-After': '600' }))).toBe(60);
    expect(retryAfterOf(new Headers({ 'Retry-After': 'soon' }))).toBe(5);
  });

  it("names a refusal in Fabric's words and says what to do", async () => {
    const { fetcher } = fakeFabric({
      '/workspaces': [
        { status: 403, body: { errorCode: 'InsufficientPrivileges', message: 'No.' } },
      ],
    });
    const answer = await fabricRequest(fetcher, BASE, 'GET', '/workspaces');
    expect(answer).toMatchObject({ ok: false, status: 403, code: 'InsufficientPrivileges' });
    expect(answer.ok ? '' : answer.error).toMatch(/Contributor.*No\./);
  });

  it('follows continuationUri across pages and reads the tables listing’s data array', async () => {
    const { fetcher } = fakeFabric({
      '/workspaces/w/lakehouses/l/tables': [
        { status: 200, body: { data: [{ name: 'a' }], continuationUri: `${BASE}/next` } },
      ],
      '/next': [{ status: 200, body: { data: [{ name: 'b' }] } }],
    });
    const listed = await fabricPages(fetcher, BASE, '/workspaces/w/lakehouses/l/tables');
    expect(listed).toEqual({ ok: true, values: [{ name: 'a' }, { name: 'b' }], truncated: false });
  });

  it('decodes a definition to text and finds the notebook among its parts', () => {
    const decoded = decodeDefinition(definitionBody);
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.format).toBe('ipynb');
    expect(mainPart(decoded)).toEqual({ path: 'notebook-content.ipynb', text: NOTEBOOK });
  });

  it('round-trips parts through the encoding Fabric takes', () => {
    const encoded = encodeDefinition([{ path: 'notebook-content.ipynb', text: NOTEBOOK }], 'ipynb');
    expect(decodeDefinition({ definition: encoded })).toEqual({
      format: 'ipynb',
      parts: [{ path: 'notebook-content.ipynb', text: NOTEBOOK }],
    });
  });

  it('a look that Fabric throttles waits longer instead of failing; a 403 fails', async () => {
    const throttled = fakeFabric({
      '/operations/op1': [{ status: 429, headers: { 'Retry-After': '20' } }],
    });
    expect(await pollOperation(throttled.fetcher, BASE, 'op1', true)).toEqual({
      state: 'running',
      percentComplete: null,
      retryAfterSeconds: 20,
    });
    const refused = fakeFabric({ '/operations/op1': [{ status: 403 }] });
    expect((await pollOperation(refused.fetcher, BASE, 'op1', true)).state).toBe('failed');
  });
});

describe('a definition fetch', () => {
  it('that Fabric answers at once is written finished with the definition', async () => {
    const { fetcher } = fakeFabric({ [GET_DEFINITION]: [{ status: 200, body: definitionBody }] });
    const started = await start(fetcher);
    expect(started.ok && started.operation).toMatchObject({
      status: 'succeeded',
      percentComplete: 100,
      operationId: null,
      finishedAt: at(0),
    });
    expect(started.ok && started.operation.result?.parts[0].text).toBe(NOTEBOOK);
  });

  it('that Fabric refuses writes nothing and says why', async () => {
    const { fetcher } = fakeFabric({ [GET_DEFINITION]: [{ status: 403 }] });
    const started = await start(fetcher);
    expect(started.ok).toBe(false);
    expect(await getDataStore().fabricOperations.list('ann', { limit: 5 })).toEqual([]);
  });

  it('that Fabric runs long is due when Retry-After says, then follows the operation to its result', async () => {
    const { fetcher, calls } = fakeFabric({
      [GET_DEFINITION]: [
        { status: 202, headers: { 'x-ms-operation-id': 'op1', 'Retry-After': '10' } },
      ],
      '/operations/op1': [
        { status: 200, body: { status: 'Running', percentComplete: 40 } },
        { status: 200, body: { status: 'Succeeded', percentComplete: 100 } },
      ],
      '/operations/op1/result': [{ status: 200, body: definitionBody }],
    });
    const started = await start(fetcher);
    if (!started.ok) throw new Error(started.error);
    expect(started.operation).toMatchObject({
      status: 'running',
      operationId: 'op1',
      nextPollAt: at(10),
    });

    // Not due yet: nothing is asked.
    expect(await advanceIfDue(started.operation.id, fetcher, BASE, at(5))).toBeNull();

    const first = await advanceIfDue(started.operation.id, fetcher, BASE, at(10));
    expect(first).toMatchObject({
      finished: false,
      operation: { percentComplete: 40, nextPollAt: at(15) },
    });

    const second = await advanceIfDue(started.operation.id, fetcher, BASE, at(15));
    expect(second?.finished).toBe(true);
    expect(second?.operation).toMatchObject({ status: 'succeeded', finishedAt: at(15) });
    expect(second?.operation?.result?.parts[0].text).toBe(NOTEBOOK);
    expect(calls).toEqual([
      `POST ${GET_DEFINITION}`,
      'GET /operations/op1',
      'GET /operations/op1',
      'GET /operations/op1/result',
    ]);
  });

  it('that Fabric fails ends failed with Fabric’s reason', async () => {
    const { fetcher } = fakeFabric({
      [GET_DEFINITION]: [{ status: 202, headers: { 'x-ms-operation-id': 'op1' } }],
      '/operations/op1': [
        {
          status: 200,
          body: { status: 'Failed', error: { errorCode: 'X', message: 'Label blocks it' } },
        },
      ],
    });
    const started = await start(fetcher);
    if (!started.ok) throw new Error(started.error);
    const advanced = await advanceIfDue(started.operation.id, fetcher, BASE, at(30));
    expect(advanced).toMatchObject({
      finished: true,
      operation: { status: 'failed', error: 'Label blocks it' },
    });
  });

  it('is reported finished by only one of two pollers that raced to the end', async () => {
    const { fetcher } = fakeFabric({
      [GET_DEFINITION]: [{ status: 202, headers: { 'x-ms-operation-id': 'op1' } }],
      '/operations/op1': [{ status: 200, body: { status: 'Succeeded' } }],
      '/operations/op1/result': [{ status: 200, body: definitionBody }],
    });
    const started = await start(fetcher);
    if (!started.ok) throw new Error(started.error);
    // Both hold the same row (a lease that lapsed mid-look, say).
    const [one, two] = await Promise.all([
      advanceOperation(started.operation, fetcher, BASE, at(30)),
      advanceOperation(started.operation, fetcher, BASE, at(30)),
    ]);
    expect([one.finished, two.finished].sort()).toEqual([false, true]);
    expect(two.operation?.status).toBe('succeeded');
  });
});

describe('reading definitions as a person does', () => {
  it('numbers a notebook’s cells with their kind', () => {
    const ipynb = JSON.stringify({
      nbformat: 4,
      cells: [
        { cell_type: 'markdown', source: ['# Load\n', 'orders'] },
        { cell_type: 'code', source: 'df = spark.read.table("orders")' },
      ],
    });
    expect(readable.notebookAsText(ipynb)).toBe(
      '--- cell 1 (markdown) ---\n# Load\norders\n\n--- cell 2 (code) ---\ndf = spark.read.table("orders")'
    );
    expect(readable.notebookProblem(ipynb)).toBeNull();
    expect(readable.notebookProblem('{"cells":[]}')).toMatch(/nbformat/);
  });

  it('lists a pipeline’s activities with what each waits on', () => {
    const json = JSON.stringify({
      properties: {
        activities: [
          { name: 'Copy orders', type: 'Copy' },
          {
            name: 'Run notebook',
            type: 'TridentNotebook',
            dependsOn: [{ activity: 'Copy orders' }],
          },
        ],
      },
    });
    expect(readable.pipelineAsText(json)).toMatch(
      /^Activities \(2\):\n- Copy orders \(Copy\)\n- Run notebook \(TridentNotebook\) after Copy orders/
    );
    expect(readable.pipelineProblem('{"activities":[]}')).toMatch(/properties/);
  });

  it('a request Renkei refused to send fails the look instead of waiting on it', async () => {
    const refusing: FabricFetch = async () => {
      throw new FabricRefusal('Microsoft Fabric is not connected.');
    };
    expect(await pollOperation(refusing, BASE, 'op1', true)).toEqual({
      state: 'failed',
      error: 'Microsoft Fabric is not connected.',
    });
  });
});
