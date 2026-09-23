/**
 * The language-server registry and the message check: every editor
 * language maps to at most one server, the protocol language id is finer
 * than Monaco's where it matters, and a message from the browser is
 * refused when it is not JSON-RPC, names a lifecycle method, or points
 * at a file outside the checkout.
 */

import {
  LANGUAGE_SERVERS,
  fileUrisIn,
  isLanguageServerId,
  languageServerFor,
  lspLanguageIdFor,
  serverArgs,
  uriInsideRoot,
  validateClientMessage,
} from './lsp';

const ROOT = 'file:///workspaces/t/h/ws-1';

describe('the registry', () => {
  test('every Monaco language belongs to one server', () => {
    const seen = new Map<string, string>();
    for (const spec of LANGUAGE_SERVERS) {
      for (const language of spec.languages) {
        expect(seen.get(language)).toBeUndefined();
        seen.set(language, spec.id);
      }
    }
    expect(languageServerFor('typescript')?.id).toBe('typescript');
    expect(languageServerFor('javascript')?.id).toBe('typescript');
    expect(languageServerFor('cpp')?.id).toBe('clangd');
    expect(languageServerFor('pgsql')?.id).toBe('sql');
    expect(languageServerFor('shell')?.id).toBe('bash');
    expect(languageServerFor('markdown')).toBeNull();
  });

  test('ids are checked, not trusted', () => {
    expect(isLanguageServerId('go')).toBe(true);
    expect(isLanguageServerId('gopls')).toBe(false);
    expect(isLanguageServerId(3)).toBe(false);
  });

  test('the protocol language id follows the file, not only the tokenizer', () => {
    expect(lspLanguageIdFor('src/App.tsx', 'typescript')).toBe('typescriptreact');
    expect(lspLanguageIdFor('src/app.jsx', 'javascript')).toBe('javascriptreact');
    expect(lspLanguageIdFor('src/app.ts', 'typescript')).toBe('typescript');
    expect(lspLanguageIdFor('db/schema.pgsql', 'pgsql')).toBe('sql');
    expect(lspLanguageIdFor('main.go', 'go')).toBe('go');
  });

  test('per-session values fill a server’s arguments', () => {
    const java = LANGUAGE_SERVERS.find((spec) => spec.id === 'java')!;
    expect(serverArgs(java, { home: '/w/home', session: 'abc' })).toEqual([
      '-data',
      '/w/home/.cache/jdtls/abc',
    ]);
    const ts = LANGUAGE_SERVERS.find((spec) => spec.id === 'typescript')!;
    expect(serverArgs(ts, { home: '/w/home', session: 'abc' })).toEqual(['--stdio']);
  });
});

describe('file URIs', () => {
  test('are found wherever a method nests them', () => {
    expect(
      fileUrisIn({
        textDocument: { uri: `${ROOT}/a.ts` },
        context: { items: [{ location: { uri: `${ROOT}/b.ts` } }] },
        edit: { documentChanges: [{ oldUri: `${ROOT}/c.ts`, newUri: `${ROOT}/d.ts` }] },
      })
    ).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`, `${ROOT}/d.ts`]);
  });

  test('inside the root means under it, without climbing out', () => {
    expect(uriInsideRoot(`${ROOT}/src/index.ts`, ROOT)).toBe(true);
    expect(uriInsideRoot(ROOT, ROOT)).toBe(true);
    expect(uriInsideRoot(`${ROOT}-other/src/index.ts`, ROOT)).toBe(false);
    expect(uriInsideRoot(`${ROOT}/../other/x.ts`, ROOT)).toBe(false);
    expect(uriInsideRoot(`${ROOT}/src/%2e%2e/x.ts`, ROOT)).toBe(false);
    expect(uriInsideRoot('file:///etc/passwd', ROOT)).toBe(false);
    // A server's own scheme (a decompiled class, a library) is its own business.
    expect(uriInsideRoot('jdt://contents/rt.jar/java.lang/String.class', ROOT)).toBe(true);
  });
});

describe('validateClientMessage', () => {
  test('takes a request, a notification and a response', () => {
    expect(
      validateClientMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'textDocument/hover',
          params: { textDocument: { uri: `${ROOT}/a.ts` }, position: { line: 0, character: 0 } },
        },
        ROOT
      ).ok
    ).toBe(true);
    expect(
      validateClientMessage(
        {
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri: `${ROOT}/a.ts` } },
        },
        ROOT
      ).ok
    ).toBe(true);
    expect(validateClientMessage({ jsonrpc: '2.0', id: 'srv-1', result: null }, ROOT).ok).toBe(
      true
    );
    expect(
      validateClientMessage({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'no' } }, ROOT).ok
    ).toBe(true);
  });

  test('refuses what is not JSON-RPC', () => {
    expect(validateClientMessage('hello', ROOT)).toEqual({
      ok: false,
      message: 'A message is a JSON-RPC 2.0 object.',
    });
    expect(validateClientMessage({ jsonrpc: '1.0', method: 'x' }, ROOT).ok).toBe(false);
    expect(validateClientMessage({ jsonrpc: '2.0', id: 1 }, ROOT).ok).toBe(false);
    expect(validateClientMessage({ jsonrpc: '2.0', method: '' }, ROOT).ok).toBe(false);
    expect(validateClientMessage({ jsonrpc: '2.0', id: { a: 1 }, method: 'x' }, ROOT).ok).toBe(
      false
    );
  });

  test('keeps the lifecycle for the worker', () => {
    for (const method of ['initialize', 'initialized', 'shutdown', 'exit']) {
      const outcome = validateClientMessage({ jsonrpc: '2.0', id: 1, method }, ROOT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toContain(method);
    }
  });

  test('refuses a file outside the checkout, in params or in a response', () => {
    const outside = validateClientMessage(
      {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: 'file:///etc/passwd', text: '' } },
      },
      ROOT
    );
    expect(outside).toEqual({ ok: false, message: 'file:///etc/passwd is outside the checkout.' });
    expect(
      validateClientMessage({ jsonrpc: '2.0', id: 9, result: { uri: `${ROOT}/../x` } }, ROOT).ok
    ).toBe(false);
  });
});
