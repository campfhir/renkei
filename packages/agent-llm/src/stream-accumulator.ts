/**
 * Folds a stream of `LlmStreamEvent`s back into the `LlmResponse` that a
 * request/response call would have returned. Both adapters build their
 * `stream()` result from this, and the chat's turn runner mirrors the
 * same events into its own live view — so "what the model said" is
 * computed by exactly one piece of code whichever way it was received.
 *
 * Tool input arrives as fragments of JSON text; they are concatenated per
 * block and parsed when the block closes. A block that never closes (the
 * stream was cut) is parsed on demand by `response()`, and unparseable
 * or empty input becomes `{}` — the same leniency `fromWireToolCall` in
 * the OpenAI adapter already applies to a model that emits broken JSON.
 */

import type { LlmContentBlock, LlmResponse, LlmStreamEvent, LlmUsage } from './contract';

export interface StreamAccumulator {
  apply(event: LlmStreamEvent): void;
  /** The blocks so far, in content-index order, tool input parsed. */
  blocks(): LlmContentBlock[];
  /** The assembled response; `stopReason` defaults to end_turn if unset. */
  response(): LlmResponse;
}

function parseInput(buffer: string): unknown {
  const trimmed = buffer.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

export function createAccumulator(): StreamAccumulator {
  const blocks = new Map<number, LlmContentBlock>();
  const jsonBuffers = new Map<number, string>();
  let stopReason: LlmResponse['stopReason'] = 'end_turn';
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

  const finishToolInput = (index: number) => {
    const block = blocks.get(index);
    const buffer = jsonBuffers.get(index);
    if (!block || block.type !== 'tool_use' || buffer === undefined) return;
    blocks.set(index, { ...block, input: parseInput(buffer) });
    jsonBuffers.delete(index);
  };

  return {
    apply(event) {
      switch (event.type) {
        case 'message_start':
          if (event.usage) usage = { ...usage, ...event.usage };
          return;
        case 'block_start':
          blocks.set(event.index, { ...event.block });
          return;
        case 'text_delta': {
          const block = blocks.get(event.index);
          if (block?.type === 'text') {
            blocks.set(event.index, { type: 'text', text: block.text + event.text });
          }
          return;
        }
        case 'thinking_delta': {
          const block = blocks.get(event.index);
          if (block?.type === 'thinking') {
            blocks.set(event.index, { ...block, thinking: block.thinking + event.thinking });
          }
          return;
        }
        case 'signature_delta': {
          const block = blocks.get(event.index);
          if (block?.type === 'thinking') {
            blocks.set(event.index, {
              ...block,
              signature: (block.signature ?? '') + event.signature,
            });
          }
          return;
        }
        case 'input_json_delta':
          jsonBuffers.set(event.index, (jsonBuffers.get(event.index) ?? '') + event.partialJson);
          return;
        case 'block_stop':
          finishToolInput(event.index);
          return;
        case 'message_end':
          stopReason = event.stopReason;
          usage = { ...usage, ...event.usage };
          return;
      }
    },
    blocks() {
      for (const index of [...jsonBuffers.keys()]) finishToolInput(index);
      return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
    },
    response() {
      return { content: this.blocks(), stopReason, usage };
    },
  };
}
