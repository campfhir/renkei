/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Language server sessions against a scripted server (test-support/
 * fake-language-server.mjs): the framing, the worker-owned handshake,
 * what is answered here and what is relayed, the buffer while no editor
 * listens, the scrub on the way out, ownership, reuse, a server that
 * dies, and the ends — close, idle, all.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LSP_IDLE_MS } from '@renkei/connector-sandbox';
import { FrameReader, LspSessions, frame, type OpenSessionInput } from './lsp-sessions';

const FAKE = join(__dirname, 'test-support', 'fake-language-server.mjs');
const OWNER = { tenantId: 'tenant-1', subject: 'code-project:p1' };
const OTHER = { tenantId: 'tenant-1', subject: 'code-project:p2' };

function fakeSpawn(env: Record<string, string> = {}) {
  return () =>
    spawn(process.execPath, [FAKE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...env },
    });
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lsp-sessions-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function input(overrides: Partial<OpenSessionInput> = {}): OpenSessionInput {
  return {
    owner: OWNER,
    workspaceId: 'ws-1',
    rootDir: root,
    home: join(root, 'home'),
    identity: null,
    server: 'typescript',
    clientId: 'editor-a',
    ...overrides,
  };
}

/** Collect what a listener gets until `count` messages, or time runs out. */
function collector(count: number, timeoutMs = 5_000) {
  const got: Record<string, unknown>[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const timer = setTimeout(() => resolveDone(), timeoutMs);
  return {
    listener: (text: string) => {
      got.push(JSON.parse(text));
      if (got.length >= count) {
        clearTimeout(timer);
        resolveDone();
      }
    },
    got,
    done,
  };
}

describe('FrameReader', () => {
  it('reassembles frames across chunks and several per chunk', () => {
    const reader = new FrameReader(1_000);
    const one = frame('{"a":1}');
    const two = frame('{"b":"ü"}');
    const all = Buffer.concat([one, two]);
    const first = reader.push(all.subarray(0, 10));
    expect(first).toEqual([]);
    const rest = reader.push(all.subarray(10));
    expect(rest).toEqual(['{"a":1}', '{"b":"ü"}']);
  });

  it('refuses a frame over the limit', () => {
    const reader = new FrameReader(4);
    expect(() => reader.push(frame('{"a":1}'))).toThrow(/over the limit/);
  });
});

describe('LspSessions', () => {
  let sessions: LspSessions;

  afterEach(async () => {
    await sessions.closeAll();
  });

  it('initialises the server itself, relays what the editor should see, and scrubs it', async () => {
    sessions = new LspSessions({ spawnServer: fakeSpawn() });
    const scrub = (text: string) => text.replaceAll('hunter2', '•••');
    const opened = await sessions.open(input());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.reused).toBe(false);
    expect(opened.session.server).toBe('typescript');
    expect(opened.session.rootUri).toBe(`file://${root}`);
    expect((opened.session.capabilities as { hoverProvider: boolean }).hoverProvider).toBe(true);
    expect(opened.session.serverInfo).toEqual({ name: 'fake-ls', version: '0.0.1' });

    // Spoken to before any editor listens: buffered, then delivered first.
    const uri = `${opened.session.rootUri}/src/a.ts`;
    expect(
      sessions.send(opened.session.id, OWNER, {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId: 'typescript', version: 1, text: 'let x' } },
      })
    ).toEqual({ ok: true });
    const first = collector(1);
    const subscribed = sessions.subscribe(opened.session.id, OWNER, first.listener, scrub);
    expect(subscribed.ok).toBe(true);
    await first.done;
    expect(first.got[0]).toMatchObject({
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [{ message: 'opened typescript' }] },
    });
    // The server's `workspace/configuration` was the worker's to answer: never relayed.
    expect(first.got.some((message) => message.method === 'workspace/configuration')).toBe(false);

    // Live: a hover answer, scrubbed, and a server request the editor answers.
    const next = collector(2);
    if (subscribed.ok) subscribed.detach();
    const again = sessions.subscribe(opened.session.id, OWNER, next.listener, scrub);
    expect(again.ok).toBe(true);
    sessions.send(opened.session.id, OWNER, {
      jsonrpc: '2.0',
      id: 7,
      method: 'textDocument/hover',
      params: { textDocument: { uri }, position: { line: 0, character: 1 } },
    });
    await next.done;
    expect(next.got[0]).toMatchObject({ id: 7 });
    const contents = (next.got[0].result as { contents: { value: string } }).contents.value;
    expect(contents).toContain(uri);
    expect(contents).toContain('token=•••');
    expect(contents).not.toContain('hunter2');
    expect(next.got[1]).toMatchObject({ method: 'window/showDocument', params: { uri } });
    // An editor's answer to that request goes back as any message does.
    expect(
      sessions.send(opened.session.id, OWNER, {
        jsonrpc: '2.0',
        id: next.got[1].id as number,
        result: { success: true },
      })
    ).toEqual({ ok: true });
    expect(sessions.count()).toBe(1);
  });

  it('is the owner’s alone, and reused by the same editor', async () => {
    sessions = new LspSessions({ spawnServer: fakeSpawn() });
    const opened = await sessions.open(input());
    if (!opened.ok) throw new Error(opened.message);
    expect(sessions.send(opened.session.id, OTHER, { jsonrpc: '2.0', method: 'x' })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(sessions.subscribe(opened.session.id, OTHER, () => {})).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await sessions.close(opened.session.id, OTHER)).toBe(false);
    expect(sessions.rootUriOf(opened.session.id, OTHER)).toBeNull();
    expect(sessions.rootUriOf(opened.session.id, OWNER)).toBe(`file://${root}`);

    const again = await sessions.open(input());
    expect(again.ok && again.reused && again.session.id === opened.session.id).toBe(true);
    const other = await sessions.open(input({ clientId: 'editor-b' }));
    expect(other.ok && !other.reused && other.session.id !== opened.session.id).toBe(true);
    expect(sessions.count()).toBe(2);

    expect(await sessions.close(opened.session.id, OWNER)).toBe(true);
    expect(sessions.count()).toBe(1);
    expect(sessions.send(opened.session.id, OWNER, { jsonrpc: '2.0', method: 'x' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('reports a server that dies, at open and after', async () => {
    sessions = new LspSessions({ spawnServer: fakeSpawn({ FAKE_LSP_CRASH: '1' }) });
    const opened = await sessions.open(input());
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.type).toBe('server_failed');
    expect(opened.message).toMatch(/crashing as asked|did not answer|refused/);
    expect(sessions.count()).toBe(0);

    // Alive, then killed underneath: the editor hears of it and a send says so.
    sessions = new LspSessions({ spawnServer: fakeSpawn() });
    const live = await sessions.open(input());
    if (!live.ok) throw new Error(live.message);
    const heard = collector(1);
    sessions.subscribe(live.session.id, OWNER, heard.listener);
    sessions.send(live.session.id, OWNER, { jsonrpc: '2.0', method: 'exit' as string });
    await heard.done;
    expect(heard.got[0]).toMatchObject({ method: '$/renkei/exited' });
    expect(sessions.send(live.session.id, OWNER, { jsonrpc: '2.0', method: 'x' })).toMatchObject({
      ok: false,
      status: 409,
      type: 'session_gone',
    });
    // The reaper lets an exited session go.
    expect(await sessions.reapIdle()).toBe(1);
    expect(sessions.count()).toBe(0);
  });

  it('lets an idle session go, but not one an editor is listening on', async () => {
    sessions = new LspSessions({ spawnServer: fakeSpawn() });
    const opened = await sessions.open(input());
    if (!opened.ok) throw new Error(opened.message);
    const subscribed = sessions.subscribe(opened.session.id, OWNER, () => {});
    expect(await sessions.reapIdle(Date.now() + LSP_IDLE_MS + 1)).toBe(0);
    if (subscribed.ok) subscribed.detach();
    expect(await sessions.reapIdle(Date.now() + LSP_IDLE_MS + 1)).toBe(1);
    expect(sessions.count()).toBe(0);
  });
});
