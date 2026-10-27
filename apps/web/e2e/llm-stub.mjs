/**
 * A stand-in model for the memory UI suite (port 8094): an
 * OpenAI-compatible endpoint (packages/agent-llm/src/openai.ts) that
 * answers every request with the same fixed reply, so an agent run or a
 * chat turn can finish without a real provider. Stateless.
 *
 *   POST /v1/chat/completions   JSON, or SSE when `stream: true`. When the
 *                               request offers `finish_run` (an agent run),
 *                               the reply is that tool call, so the run
 *                               ends `done` with the fixed summary; any
 *                               other request gets the fixed text.
 *
 * A scripted reply, for a spec that needs the model to do something in
 * particular (stage actions, ask a question, call a read tool): put
 *
 *   [[stub-script]][{"tool":"ask_person","args":{…}},{"text":"…"}][[/stub-script]]
 *
 * anywhere in what the model is sent — an agent's instructions, a chat
 * message. Reply n (n = the assistant messages already in the request)
 * is step n: a `tool` step is that one tool call with its `args` (and
 * `text` beside it, if given), a `text` step that text alone. Past the last step, or with no script at all,
 * the reply is the default above.
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

const SCRIPT = /\[\[stub-script\]\]([\s\S]*?)\[\[\/stub-script\]\]/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

/** The scripted step for this request, or null for the default reply. */
function scriptedStep(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const entry of messages) {
    const match = SCRIPT.exec(textOf(entry?.content));
    if (!match) continue;
    let steps;
    try {
      steps = JSON.parse(match[1]);
    } catch {
      return null;
    }
    if (!Array.isArray(steps)) return null;
    const replied = messages.filter((m) => m?.role === 'assistant').length;
    return steps[replied] ?? null;
  }
  return null;
}

let nextCall = 0;

const USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

function message(body) {
  const step = scriptedStep(body);
  if (step && typeof step.tool === 'string') {
    nextCall += 1;
    return {
      role: 'assistant',
      content: typeof step.text === 'string' ? step.text : null,
      tool_calls: [
        {
          id: `call_stub_${nextCall}`,
          type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
        },
      ],
    };
  }
  if (step && typeof step.text === 'string') return { role: 'assistant', content: step.text };
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
    if (reply.content) chunk({ role: 'assistant', content: reply.content });
    chunk({
      role: 'assistant',
      tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })),
    });
    chunk({}, 'tool_calls', USAGE);
  } else {
    chunk({ role: 'assistant', content: '' });
    for (const word of reply.content.split(/(?<= )/)) chunk({ content: word });
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
