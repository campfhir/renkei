/**
 * One call site for "give me the answer as it arrives": uses the
 * provider's `stream()` when it has one and otherwise runs `complete()`
 * and replays the finished response as the same events. The chat's turn
 * runner only ever calls this, so a provider without streaming (a test
 * double, a future adapter landed request/response first) still produces
 * a correct — merely unanimated — turn.
 */

import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamOptions,
} from './contract';

export async function streamOrComplete(
  provider: LlmProvider,
  request: LlmRequest,
  options: LlmStreamOptions
): Promise<Result<LlmResponse, LlmErrorKind>> {
  if (provider.stream) return provider.stream(request, options);

  const result = await provider.complete(request);
  if (!result.ok) return result;
  const { onEvent } = options;
  onEvent({ type: 'message_start' });
  result.val.content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        onEvent({ type: 'block_start', index, block: { type: 'text', text: '' } });
        if (block.text) onEvent({ type: 'text_delta', index, text: block.text });
        break;
      case 'thinking':
        onEvent({ type: 'block_start', index, block: { type: 'thinking', thinking: '' } });
        if (block.thinking) onEvent({ type: 'thinking_delta', index, thinking: block.thinking });
        if (block.signature) {
          onEvent({ type: 'signature_delta', index, signature: block.signature });
        }
        break;
      default:
        // tool_use (input already parsed), redacted_thinking, documents:
        // the skeleton IS the block.
        onEvent({ type: 'block_start', index, block });
    }
    onEvent({ type: 'block_stop', index });
  });
  onEvent({ type: 'message_end', stopReason: result.val.stopReason, usage: result.val.usage });
  return ok(result.val);
}
