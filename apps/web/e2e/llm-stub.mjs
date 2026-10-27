/**
 * A stand-in model for the memory UI suite (port 8094): an
 * OpenAI-compatible endpoint (packages/agent-llm/src/openai.ts) that
 * answers every request with the same fixed reply, so an agent run or a
 * chat turn can finish without a real provider. Stateless.
 *
 *   POST /v1/chat/completions   JSON, or SSE when `stream: true`. When the
 *                               request offers `finish_run` (an agent run),
 *                               the reply is that tool call, so the run
 *                               ends `done` with the fixed summary. A
 *                               prompt whose lines read
 *                               `stub:call <tool> <json input>` gets those
 *                               tool calls, one per round in order, and
 *                               then the fixed text (so a chat turn can
 *                               run real tools). Any other request gets
 *                               the fixed text.
 *   POST /v1/embeddings         an OpenAI-compatible embedding of each
 *                               input: 1536 numbers, the same for every
 *                               text (an organization's embedding
 *                               provider, for knowledge notes)
 *   GET  /v1/models             one model, `stub-model`
 *   GET  /health
 *
 * A spec points a model at it through the admin LLM-models route
 * (provider `openai`, base URL `http://127.0.0.1:8094/v1`).
 */

/* global console, process, URL */

import { createServer } from 'node:http';

const PORT = Number(process.env.E2E_LLM_STUB_PORT ?? 8094);
// Mirrored by LLM_STUB_REPLY in e2e/memory/constants.ts.
const STUB_REPLY = 'The stub model finished the work.';

function readJson(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function offersFinishRun(body) {
  return (
    Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === 'finish_run')
  );
}

const USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/**
 * The next scripted call of the last prompt (`stub:call <tool> <json>`
 * lines), or null when it scripts none or all of them have been answered.
 * Stateless: the calls already made are counted from the conversation.
 */
function scriptedCall(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let last = -1;
  messages.forEach((entry, index) => {
    if (entry?.role === 'user' && /^stub:call /m.test(textOf(entry.content))) last = index;
  });
  if (last === -1) return null;
  const script = textOf(messages[last].content)
    .split('\n')
    .map((line) => /^stub:call (\S+) (.*)$/.exec(line.trim()))
    .filter(Boolean);
  const answered = messages
    .slice(last + 1)
    .filter(
      (entry) => entry?.role === 'tool' && String(entry.tool_call_id).startsWith('call_stub_')
    ).length;
  const next = script[answered];
  if (!next) return null;
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `call_stub_${answered + 1}`,
        type: 'function',
        function: { name: next[1], arguments: next[2] },
      },
    ],
  };
}

function message(body) {
  const scripted = scriptedCall(body);
  if (scripted) return scripted;
  if (!offersFinishRun(body)) return { role: 'assistant', content: STUB_REPLY };
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_stub_finish',
        type: 'function',
        function: {
          name: 'finish_run',
          arguments: JSON.stringify({ outcome: 'done', summary: STUB_REPLY }),
        },
      },
    ],
  };
}

function sendStream(response, body) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta, finishReason = null, usage) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        model: body.model ?? 'stub-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`
    );
  const reply = message(body);
  if (reply.tool_calls) {
    chunk({
      role: 'assistant',
      tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })),
    });
    chunk({}, 'tool_calls', USAGE);
  } else {
    chunk({ role: 'assistant', content: '' });
    for (const word of STUB_REPLY.split(/(?<= )/)) chunk({ content: word });
    chunk({}, 'stop', USAGE);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'list',
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding })),
        model: body.model ?? 'stub-embedding',
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      })
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(request);
    if (body.stream) {
      sendStream(response, body);
      return;
    }
    const reply = message(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        model: body.model ?? 'stub-model',
        choices: [
          { index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' },
        ],
        usage: USAGE,
      })
    );
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`llm stub listening on http://127.0.0.1:${PORT}`);
});
