/**
 * A stand-in model for the Playwright suite (port 8094). Stateless: what it
 * answers is read off each request.
 *
 *   POST /v1/chat/completions    OpenAI dialect (packages/agent-llm/src/openai.ts)
 *   POST /anthropic/v1/messages  Anthropic dialect (…/anthropic.ts), for signed
 *                                thinking and the composer's thinking switch
 *        both JSON, or SSE when `stream: true`
 *   POST /v1/embeddings          1536 numbers per input, the same for every text
 *   POST /v1/images/generations  one picture of the size asked for (handleImages);
 *        /v1/images/edits        the same, multipart
 *   GET  /v1/models, /health
 *
 * A spec puts a model on the roster through the admin LLM-models route
 * (e2e/support/stub-model.ts): provider `openai` and base URL
 * `http://127.0.0.1:8094/v1`, or provider `anthropic` and
 * `http://127.0.0.1:8094/anthropic`.
 *
 * Unscripted, a request that offers `finish_run` (an agent run) gets that
 * call — outcome `done`, the fixed summary below; one that forces
 * `artifact_digest` (lib/chat/artifact-digest.ts) gets a digest — of a
 * picture a fixed description, of text `Stub summary: <its first line>`
 * with its longer words as keywords; any other the fixed text.
 *
 * Scripted: anywhere in what the model is sent — an agent's instructions, a
 * chat message, a delegated task, a file's text — a block
 *
 *   [[stub-script]] <base64 of a JSON array of steps> [[/stub-script]]
 *
 * (stubScript in e2e/support/stub-model.ts writes it; whitespace in the
 * base64 is ignored, so it wraps in a chat bubble, and encoded, the
 * replies it scripts never read as page text of their own). The last block
 * in the last system or user message carrying one is the script, and a
 * request is answered by step n, n being the assistant messages after that
 * message (bar calls the app made itself, such as a code chat's clone):
 * each tool round trip moves one step on. Past the last step, the
 * unscripted answer. A step is
 *
 *   { "text"?: string,                         said (beside the calls, or alone)
 *     "reasoning"?: string,                    streamed as reasoning / signed thinking
 *     "tools"?: [{ "name": string, "input"?: object }],   called, in one round
 *     "usage"?: { "input": n, "output": n, "cached"?: n },
 *     "delayMs"?: n,                           held this long before answering
 *     "oneShot"?: true }
 *
 * A step answers a turn — a request offering tools without forcing one. With
 * `oneShot` it answers instead a one-shot call (no tools, or one forced: a
 * chat title, an artifact digest, a compaction summary), which a turn's
 * steps never touch.
 */

/* global Buffer, console, process, setTimeout, URL */

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const PORT = Number(process.env.E2E_LLM_STUB_PORT ?? 8094);
// Mirrored by LLM_STUB_REPLY in e2e/memory/constants.ts.
const STUB_REPLY = 'The stub model finished the work.';
// Mirrored by LLM_STUB_PICTURE.
const STUB_PICTURE = 'A picture the stub model looked at.';
const BLOCK = /\[\[stub-script\]\]([A-Za-z0-9+/=\s]*)\[\[\/stub-script\]\]/g;

function readRaw(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readJson(request) {
  try {
    return JSON.parse((await readRaw(request)).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

function scriptIn(text) {
  const body = [...text.matchAll(BLOCK)].at(-1)?.[1];
  if (body === undefined) return null;
  try {
    const steps = JSON.parse(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'));
    return Array.isArray(steps) ? steps : null;
  } catch {
    return null;
  }
}

/** An assistant message holding only calls the app made itself (a code chat's clone). */
const foreign = (ids) => ids.length > 0 && ids.every((id) => !String(id).startsWith('call_stub_'));

/**
 * The step answering this request. `messages` are `{ role, text, foreign? }`,
 * the system prompt first; `turn` says whether tools are offered and none forced.
 */
function stepFor(messages, turn, tools, pictured) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const { role, text } = messages[index];
    if (role === 'assistant' || role === 'tool') continue;
    const steps = scriptIn(text);
    if (!steps) continue;
    const n = messages.slice(index + 1).filter((m) => m.role === 'assistant' && !m.foreign).length;
    const step = steps[n];
    if (step && Boolean(step.oneShot) !== turn) return step;
    break;
  }
  if (!turn && tools.includes('artifact_digest')) {
    const said = messages.findLast((m) => m.role === 'user')?.text ?? '';
    const text = said.replace(/^<file[^>]*>\n?/, '').replace(/\n?<\/file>$/, '');
    const input = pictured
      ? { summary: STUB_PICTURE, keywords: ['picture', 'stub'] }
      : {
          summary: `Stub summary: ${(text.split('\n').find((line) => line.trim()) ?? '').trim()}`,
          keywords: [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 8),
        };
    return { tools: [{ name: 'artifact_digest', input }] };
  }
  if (tools.includes('finish_run')) {
    return { tools: [{ name: 'finish_run', input: { outcome: 'done', summary: STUB_REPLY } }] };
  }
  return { text: STUB_REPLY };
}

let calls = 0;
const callsOf = (step) =>
  (step.tools ?? []).map((call) => ({
    id: `call_stub_${(calls += 1)}`,
    name: call.name,
    input: call.input ?? {},
  }));
const usageOf = (step) => ({ input: 12, output: 8, cached: 0, ...step.usage });
const words = (text) => text.split(/(?<= )/);
const hold = (step) => new Promise((resolve) => setTimeout(resolve, step.delayMs ?? 0));

async function openai(response, body) {
  const messages = (body.messages ?? []).map((m) => ({
    role: m?.role,
    text: textOf(m?.content),
    foreign: foreign((m?.tool_calls ?? []).map((call) => call?.id)),
  }));
  const tools = (body.tools ?? []).map((tool) => tool?.function?.name);
  const turn = tools.length > 0 && typeof body.tool_choice !== 'object';
  const step = stepFor(
    messages,
    turn,
    tools,
    JSON.stringify(body.messages).includes('"type":"image')
  );
  await hold(step);
  const toolCalls = callsOf(step).map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));
  const u = usageOf(step);
  const usage = {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    ...(u.cached ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}),
  };
  const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const base = { id: 'chatcmpl-stub', model: body.model ?? 'stub-model' };
  if (!body.stream) {
    const message = {
      role: 'assistant',
      content: step.text ?? null,
      ...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      })
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finishReason = null, extra = {}) =>
    response.write(
      `data: ${JSON.stringify({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      })}\n\n`
    );
  chunk({ role: 'assistant', content: '' });
  if (step.reasoning) chunk({ reasoning_content: step.reasoning });
  for (const word of words(step.text ?? '')) chunk({ content: word });
  if (toolCalls.length > 0) {
    chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
  }
  chunk({}, finish, { usage });
  response.end('data: [DONE]\n\n');
}

async function anthropic(response, body) {
  const system = { role: 'system', text: textOf(body.system) };
  const messages = [system, ...(body.messages ?? [])].map((m) => {
    const results = Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');
    const ids = Array.isArray(m.content)
      ? m.content.filter((b) => b?.type === 'tool_use').map((b) => b.id)
      : [];
    return { role: results ? 'tool' : m.role, text: textOf(m.content), foreign: foreign(ids) };
  });
  const tools = (body.tools ?? []).map((tool) => tool?.name);
  const turn = tools.length > 0 && body.tool_choice?.type !== 'tool';
  const step = stepFor(
    messages,
    turn,
    tools,
    JSON.stringify(body.messages).includes('"type":"image')
  );
  await hold(step);
  const blocks = [
    ...(step.reasoning
      ? [{ type: 'thinking', thinking: step.reasoning, signature: 'stub-signature' }]
      : []),
    ...(step.text ? [{ type: 'text', text: step.text }] : []),
    ...callsOf(step).map((call) => ({ type: 'tool_use', ...call })),
  ];
  const stop = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const u = usageOf(step);
  const usage = {
    input_tokens: u.input,
    output_tokens: u.output,
    ...(u.cached ? { cache_read_input_tokens: u.cached } : {}),
  };
  if (body.stream !== true) {
    response.writeHead(200, { 'content-type': 'application/json' });
    const message = { type: 'message', role: 'assistant', content: blocks, stop_reason: stop };
    response.end(JSON.stringify({ ...message, usage }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = (event) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const delta = (index, d) => frame({ type: 'content_block_delta', index, delta: d });
  frame({ type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    const start = (content_block) => frame({ type: 'content_block_start', index, content_block });
    if (block.type === 'thinking') {
      start({ type: 'thinking', thinking: '' });
      delta(index, { type: 'thinking_delta', thinking: block.thinking });
      delta(index, { type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'text') {
      start({ type: 'text', text: '' });
      for (const word of words(block.text)) delta(index, { type: 'text_delta', text: word });
    } else {
      start({ ...block, input: {} });
      delta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input) });
    }
    frame({ type: 'content_block_stop', index });
  });
  frame({
    type: 'message_delta',
    delta: { stop_reason: stop },
    usage: { output_tokens: u.output },
  });
  frame({ type: 'message_stop' });
  response.end();
}

/** A real w×h PNG of one colour. */
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An edit (a frame built on the one before) is multipart: its prompt and size. */
async function readForm(request) {
  const raw = (await readRaw(request)).toString('latin1');
  const field = (name) =>
    new RegExp(`name="${name}"\\r\\n(?:[^\\r\\n]*\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(
      raw
    )?.[1];
  const prompt = field('prompt');
  return {
    prompt: prompt === undefined ? '' : Buffer.from(prompt, 'latin1').toString('utf8'),
    size: field('size'),
  };
}

/**
 * The OpenAI Images API (packages/agent-llm/src/images.ts), for a model on
 * the `images` surface: one picture of the size asked for, a colour of its
 * own per prompt (so an animation's frames differ), with gpt-image's usage.
 * The person's message rides in the prompt: `[refuse 1024x1024]` has the
 * safety system refuse that size, `[slow]` holds the answer half a minute.
 */
async function handleImages(request, response, edit) {
  const body = edit ? await readForm(request) : await readJson(request);
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const size = /^(\d+)x(\d+)$/.exec(body.size ?? '') ?? [null, '1024', '1024'];
  const [width, height] = [Number(size[1]), Number(size[2])];
  if (prompt.includes(`[refuse ${width}x${height}]`)) {
    response.writeHead(400, { 'content-type': 'application/json' });
    const message = 'Your request was rejected by the safety system.';
    response.end(JSON.stringify({ error: { code: 'moderation_blocked', message } }));
    return;
  }
  if (prompt.includes('[slow]')) await new Promise((resolve) => setTimeout(resolve, 30_000));
  let hash = 0;
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const png = solidPng(width, height, [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff]);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: png.toString('base64') }],
      usage: { input_tokens: 61, output_tokens: 4160, total_tokens: 4221 },
    })
  );
}

async function handleEmbeddings(request, response) {
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
}

const ROUTES = {
  'GET /health': (_, response) => response.end('{"ok":true}'),
  'GET /v1/models': (_, response) =>
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] })),
  'POST /v1/chat/completions': async (request, response) =>
    openai(response, await readJson(request)),
  'POST /anthropic/v1/messages': async (request, response) =>
    anthropic(response, await readJson(request)),
  'POST /v1/embeddings': handleEmbeddings,
  'POST /v1/images/generations': (request, response) => handleImages(request, response, false),
  'POST /v1/images/edits': (request, response) => handleImages(request, response, true),
};

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const route = ROUTES[`${request.method} ${pathname}`];
  if (route) return route(request, response);
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`llm stub listening on http://127.0.0.1:${PORT}`);
});
