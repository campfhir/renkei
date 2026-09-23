/**
 * A language server for the tests: speaks the protocol's framing over
 * stdio, answers `initialize` with a few capabilities, publishes a
 * diagnostic for every document opened, answers hover with the file's
 * URI and a secret-looking word (so the scrub can be seen to work), asks
 * the client for its configuration once (a server→client request the
 * worker answers itself), forwards one server→client request the
 * worker does NOT answer (`window/showDocument`) so the relay of those
 * can be seen, and exits on `exit` — or, with FAKE_LSP_CRASH set, dies
 * straight after initialize to exercise the exit path.
 */

import { Buffer } from 'node:buffer';
import process from 'node:process';

let pending = Buffer.alloc(0);
let serverRequestId = 100;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      if (process.env.FAKE_LSP_CRASH) {
        process.stderr.write('fake-ls: crashing as asked\n');
        process.exit(3);
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            completionProvider: { triggerCharacters: ['.'] },
            definitionProvider: true,
          },
          // The pid the client gave, echoed so a test can see it: a server
          // exits when it cannot signal that pid, so the worker sends none.
          serverInfo: { name: 'fake-ls', version: '0.0.1', processId: params.processId ?? null },
        },
      });
      // A request the worker answers on the client's behalf.
      send({
        jsonrpc: '2.0',
        id: serverRequestId++,
        method: 'workspace/configuration',
        params: { items: [{ section: 'fake' }] },
      });
      return;
    case 'initialized':
      return;
    case 'textDocument/didOpen':
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: params.textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              severity: 2,
              message: `opened ${params.textDocument.languageId}`,
            },
          ],
        },
      });
      return;
    case 'textDocument/hover':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          contents: {
            kind: 'markdown',
            value: `hover for ${params.textDocument.uri} token=hunter2`,
          },
        },
      });
      // A request only the editor can answer, relayed as it came.
      send({
        jsonrpc: '2.0',
        id: serverRequestId++,
        method: 'window/showDocument',
        params: { uri: params.textDocument.uri },
      });
      return;
    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: null });
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (id !== undefined && method !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method} here` } });
      }
  }
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const headerEnd = pending.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = pending.subarray(0, headerEnd).toString('ascii');
    const length = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
    const start = headerEnd + 4;
    if (pending.length < start + length) return;
    const body = pending.subarray(start, start + length).toString('utf8');
    pending = pending.subarray(start + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
