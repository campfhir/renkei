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
 *   POST /v1/images/generations one picture (see handleImages), for a
 *                               model on the `images` surface; /edits
 *                               (multipart) the same
 *   GET  /v1/models             one model, `stub-model`
 *   GET  /health
 *
 * A spec points a model at it through the admin LLM-models route
 * (provider `openai`, base URL `http://127.0.0.1:8094/v1`).
 *
 * A scripted model: a base URL of `http://127.0.0.1:8094/v1/script/<s>`,
 * where <s> is a base64url JSON script (e2e/support/stub-model.ts writes
 * it), answers what the script says instead — still stateless, since the
 * script rides on every request's own path:
 *
 *   { "replies": [ { "when": "<text in the person's last message>",
 *                    "untooled"?: true,
 *                    "steps": [ { "text"?, "reasoning"?,
 *                                 "tools"?: [{ "name", "input" }],
 *                                 "usage"?: { "input", "output", "cached"? },
 *                                 "delayMs"? } ] } ] }
 *
 * The first reply whose `when` the last user message contains (a reply
 * with no `when` matches any) is played step by step: step N answers the
 * request that already carries N assistant messages after that user
 * message, so a tool call's round trip lands on the next step. Past the
 * last step, or with no reply matching, the fixed answer above. Only
 * requests that offer tools freely are scripted (a chat turn, not the
 * one-shot title, digest or summary calls, which offer none or force
 * one), unless the reply says `"untooled": true`.
 *
 * The same script speaks Anthropic's Messages dialect at
 * `http://127.0.0.1:8094/anthropic/script/<s>` (POST …/v1/messages), for
 * a model that needs signed thinking or the composer's thinking switch.
 */

/* global Buffer, console, process, setTimeout, URL */

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

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

/** The script a scripted base URL carries, or null. */
function scriptOf(pathname) {
  const match = /^\/v1\/script\/([A-Za-z0-9_-]+)\/chat\/completions$/.exec(pathname);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** The script's step for this request, or null for the fixed answer. */
function scriptedStep(script, body) {
  if (!script || !Array.isArray(script.replies)) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && typeof messages[index].content === 'string') {
      lastUser = index;
      break;
    }
  }
  const said = lastUser >= 0 ? textOf(messages[lastUser].content) : '';
  // A turn offers its tools freely; a one-shot call forces one (the title, a digest).
  const tooled =
    Array.isArray(body.tools) && body.tools.length > 0 && typeof body.tool_choice !== 'object';
  const reply = script.replies.find(
    (candidate) =>
      (tooled || candidate.untooled === true) &&
      (typeof candidate.when !== 'string' || said.includes(candidate.when))
  );
  if (!reply || !Array.isArray(reply.steps)) return null;
  const answered = messages
    .slice(lastUser + 1)
    .filter((message) => message?.role === 'assistant').length;
  return reply.steps[answered] ?? null;
}

function usageOf(step) {
  if (!step?.usage) return USAGE;
  const input = Number(step.usage.input ?? 0);
  const output = Number(step.usage.output ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(step.usage.cached ? { prompt_tokens_details: { cached_tokens: step.usage.cached } } : {}),
  };
}

function stepMessage(step) {
  const calls = Array.isArray(step.tools) ? step.tools : [];
  return {
    role: 'assistant',
    content: typeof step.text === 'string' ? step.text : null,
    ...(typeof step.reasoning === 'string' ? { reasoning_content: step.reasoning } : {}),
    ...(calls.length > 0
      ? {
          tool_calls: calls.map((call, index) => ({
            id: `call_stub_${Date.now()}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        }
      : {}),
  };
}

function message(body, step) {
  if (step) return stepMessage(step);
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

function sendStream(response, body, step) {
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
  const reply = message(body, step);
  const usage = usageOf(step);
  if (reply.reasoning_content) {
    chunk({ role: 'assistant', reasoning_content: reply.reasoning_content });
  }
  if (typeof reply.content === 'string' && reply.content) {
    chunk({ role: 'assistant', content: '' });
    for (const word of reply.content.split(/(?<= )/)) chunk({ content: word });
  }
  if (reply.tool_calls) {
    chunk({
      role: 'assistant',
      tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })),
    });
    chunk({}, 'tool_calls', usage);
  } else {
    chunk({}, 'stop', usage);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

/**
 * The same script in Anthropic's Messages dialect
 * (packages/agent-llm/src/anthropic.ts), for a model that needs what only
 * that dialect carries: signed thinking, a thinking switch in the
 * composer. Base URL `http://127.0.0.1:8094/anthropic/script/<s>`.
 */
function anthropicScriptOf(pathname) {
  const match = /^\/anthropic\/script\/([A-Za-z0-9_-]+)\/v1\/messages$/.exec(pathname);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** The Messages request seen as the chat-completions one scriptedStep reads. */
function asCompletionsBody(body) {
  const messages = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const blocks = typeof message.content === 'string' ? null : message.content;
    const results = Array.isArray(blocks) && blocks.some((block) => block?.type === 'tool_result');
    if (message.role === 'user' && !results) {
      messages.push({ role: 'user', content: textOf(message.content) });
    } else if (message.role === 'user') {
      messages.push({ role: 'tool' });
    } else {
      messages.push({ role: 'assistant' });
    }
  }
  const forced = body.tool_choice?.type === 'tool' ? { forced: body.tool_choice.name } : undefined;
  return { messages, tools: body.tools ?? [], tool_choice: forced };
}

function anthropicBlocks(step) {
  if (!step) return [{ type: 'text', text: STUB_REPLY }];
  const blocks = [];
  if (typeof step.reasoning === 'string') {
    blocks.push({ type: 'thinking', thinking: step.reasoning, signature: 'stub-signature' });
  }
  if (typeof step.text === 'string' && step.text) blocks.push({ type: 'text', text: step.text });
  for (const [index, call] of (step.tools ?? []).entries()) {
    blocks.push({
      type: 'tool_use',
      id: `toolu_stub_${Date.now()}_${index}`,
      name: call.name,
      input: call.input ?? {},
    });
  }
  return blocks;
}

function anthropicUsage(step) {
  const usage = usageOf(step);
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    ...(usage.prompt_tokens_details
      ? { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
  };
}

function sendAnthropic(response, body, step) {
  const blocks = anthropicBlocks(step);
  const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const usage = anthropicUsage(step);
  if (body.stream !== true) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: blocks,
        stop_reason: stopReason,
        usage,
      })
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = (event) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  frame({ type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      frame({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      frame({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      frame({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else if (block.type === 'text') {
      frame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const word of block.text.split(/(?<= )/)) {
        frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } });
      }
    } else {
      frame({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      frame({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    frame({ type: 'content_block_stop', index });
  });
  frame({
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: usage.output_tokens },
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

/**
 * The OpenAI Images API (packages/agent-llm/src/images.ts), for a model
 * on the `images` surface: one picture of the size asked for, a colour of
 * its own per prompt (so an animation's frames differ), with gpt-image's
 * usage. The person's message rides in the prompt, so it can steer:
 * `[refuse 1024x1024]` has the safety system refuse that size, `[slow]`
 * holds the answer for half a minute.
 */
/** An edit (a frame built on the one before) is multipart: its prompt and size, read off the form. */
function readForm(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      const field = (name) =>
        new RegExp(`name="${name}"\\r\\n(?:[^\\r\\n]*\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(
          raw
        )?.[1];
      const prompt = field('prompt');
      resolve({
        prompt: prompt === undefined ? '' : Buffer.from(prompt, 'latin1').toString('utf8'),
        size: field('size'),
      });
    });
  });
}

async function handleImages(request, response, edit = false) {
  const body = edit ? await readForm(request) : await readJson(request);
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const size = /^(\d+)x(\d+)$/.exec(body.size ?? '') ?? [null, '1024', '1024'];
  const [width, height] = [Number(size[1]), Number(size[2])];
  if (prompt.includes(`[refuse ${width}x${height}]`)) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: 'moderation_blocked',
          message: 'Your request was rejected by the safety system.',
        },
      })
    );
    return;
  }
  if (prompt.includes('[slow]')) await new Promise((resolve) => setTimeout(resolve, 30_000));
  let hash = 0;
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const colour = [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff];
  const png = solidPng(width, height, colour);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: png.toString('base64') }],
      usage: { input_tokens: 61, output_tokens: 4160, total_tokens: 4221 },
    })
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === 'GET' && /^\/v1(\/script\/[A-Za-z0-9_-]+)?\/models$/.test(url.pathname)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
    await handleImages(request, response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/images/edits') {
    await handleImages(request, response, true);
    return;
  }
  const anthropicScript = anthropicScriptOf(url.pathname);
  if (request.method === 'POST' && anthropicScript) {
    const body = await readJson(request);
    const step = scriptedStep(anthropicScript, asCompletionsBody(body));
    if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    sendAnthropic(response, body, step);
    return;
  }
  const script = scriptOf(url.pathname);
  if (request.method === 'POST' && (url.pathname === '/v1/chat/completions' || script)) {
    const body = await readJson(request);
    const step = scriptedStep(script, body);
    if (process.env.E2E_LLM_STUB_LOG) {
      console.log(
        JSON.stringify({
          tools: (body.tools ?? []).map((tool) => tool?.function?.name),
          last: body.messages?.at(-1),
          step,
        })
      );
    }
    if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (body.stream) {
      sendStream(response, body, step);
      return;
    }
    const reply = message(body, step);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        model: body.model ?? 'stub-model',
        choices: [
          { index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' },
        ],
        usage: usageOf(step),
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
