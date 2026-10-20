'use client';

/**
 * How full the conversation's context is: tokens the last model call read
 * (plus what it wrote, which the next call resends) against the selected
 * model's context window, when the admin recorded one. Without a limit it
 * still shows the count. Nothing renders before the first reply, since
 * there is no usage to report yet.
 */

import type { ChatMessageView, ModelOption } from '@/lib/chat/views';

/** Tokens the next call will start from: the newest finished reply's input plus output. */
export function contextTokensOf(messages: ChatMessageView[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index].usage;
    if (messages[index].role === 'assistant' && usage) {
      return usage.inputTokens + usage.outputTokens;
    }
  }
  return null;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

export default function ContextMeter({
  messages,
  model,
}: {
  messages: ChatMessageView[];
  model: ModelOption | null;
}) {
  const used = contextTokensOf(messages);
  if (used === null) return null;
  const limit = model?.contextWindow ?? null;
  const fraction = limit ? Math.min(used / limit, 1) : null;
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const tone =
    fraction === null
      ? 'bg-gray-400'
      : fraction >= 0.9
        ? 'bg-red-500'
        : fraction >= 0.75
          ? 'bg-amber-500'
          : 'bg-blue-500';
  const text = limit ? `${compact(used)} / ${compact(limit)}` : `${compact(used)} tokens`;
  const title = limit
    ? `Context: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens (${percent}%)`
    : `Context: ${used.toLocaleString()} tokens. No context window is recorded for this model.`;

  return (
    <div
      data-testid="context-meter"
      title={title}
      className="flex shrink-0 items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400"
    >
      {fraction !== null ? (
        <div
          role="progressbar"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          className="h-1.5 w-12 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        >
          <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <span data-testid="context-meter-text">{text}</span>
    </div>
  );
}
