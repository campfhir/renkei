'use client';

/**
 * A picture the model had drawn (chat_generate_image), shown inline where
 * the call was made — never folded away with the other tool calls.
 *
 *   - Waiting for the person's permission, the card is just its caption:
 *     nothing is being drawn yet, so there is no outline to promise one.
 *   - Once it is approved and being drawn, the card is an outline of the
 *     picture's SHAPE — the aspect ratio of the `size` or `aspectRatio` the
 *     model chose, read even from half-arrived input — so the thread does
 *     not jump when the image lands.
 *   - When it is done the image appears in that outline, and opens full
 *     size in a new tab. It is the file the call kept (the chat's
 *     Artifacts), found by the tool_results row that carried it.
 *   - When it failed, the reason is shown plainly beside the image icon.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import { skeletonRatio } from '@/lib/chat/image-size';
import type { ChatBlock } from '@/lib/chat/views';
import type { AttachmentView } from '@/lib/chat/views';

type CallBlock = Extract<ChatBlock, { type: 'tool_use' }>;
type ResultBlock = Extract<ChatBlock, { type: 'tool_result' }>;

/** The tallest the picture (or its outline) stands in the thread, in pixels. */
const MAX_HEIGHT = 384;

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type ImageCardState = 'waiting' | 'pending' | 'done' | 'failed';

export default function ImageCard({
  tenantId,
  call,
  result,
  state,
  image,
}: {
  tenantId: string;
  call: CallBlock;
  result: ResultBlock | null;
  state: ImageCardState;
  /** The stored file this call kept, once there is one. */
  image: AttachmentView | null;
}) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // An image the server rendered (or the browser had cached) can finish
  // before React hydrates, and then onLoad never fires: ask the element.
  const src = image ? chatClient.attachmentUrl(tenantId, image.id) : null;
  useEffect(() => {
    const element = imgRef.current;
    if (!element || !element.complete) return;
    if (element.naturalWidth > 0) setLoaded(true);
    else setBroken(true);
  }, [src]);
  const ratio = skeletonRatio(call.input, call.partialJson);
  // Width that makes the outline MAX_HEIGHT tall at most, and never wider than the thread.
  const outline = {
    aspectRatio: String(ratio),
    maxWidth: `min(100%, ${Math.round(MAX_HEIGHT * ratio)}px)`,
  } as const;

  const label =
    state === 'waiting'
      ? 'Waiting for permission to generate an image'
      : state === 'pending'
        ? 'Generating image'
        : state === 'failed'
          ? 'Image could not be generated'
          : 'Generated image';

  const showImage = state === 'done' && src !== null && !broken;

  return (
    <figure
      className="my-2 max-w-2xl"
      data-testid="image-card"
      data-state={state}
      data-ratio={ratio.toFixed(3)}
    >
      <figcaption className="mb-1.5 flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
        <Icon path={ICONS.image} className="h-3.5 w-3.5 shrink-0" />
        <span className={state === 'failed' ? 'text-red-600 dark:text-red-400' : undefined}>
          {label}
        </span>
        {state === 'pending' ? <span className="chat-dots" aria-hidden="true" /> : null}
        {result?.durationMs !== undefined ? (
          <span className="text-xs text-gray-400" data-call-duration>
            {formatDuration(result.durationMs)}
          </span>
        ) : null}
      </figcaption>

      {state === 'waiting' ? null : state === 'failed' ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          data-testid="image-card-error"
        >
          {result?.content || 'The image tool failed.'}
        </p>
      ) : (
        <div
          className="relative w-full overflow-hidden rounded-lg border border-dashed border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-900"
          style={
            showImage && loaded
              ? { width: 'fit-content', maxWidth: '100%', borderStyle: 'solid' }
              : outline
          }
          data-testid={showImage && loaded ? 'image-card-picture' : 'image-card-skeleton'}
        >
          {showImage ? (
            // A picture the model drew is the person's to open full size.
            <a href={src} target="_blank" rel="noreferrer" className="block">
              <img
                ref={imgRef}
                src={src}
                alt={image?.filename ?? 'Generated image'}
                onLoad={() => setLoaded(true)}
                onError={() => setBroken(true)}
                className={
                  loaded
                    ? 'block h-auto w-auto max-w-full'
                    : 'absolute inset-0 h-full w-full object-contain'
                }
                style={loaded ? { maxHeight: MAX_HEIGHT } : undefined}
              />
            </a>
          ) : null}
          {!(showImage && loaded) ? (
            <div
              className="absolute inset-0 flex items-center justify-center text-gray-400 motion-safe:animate-pulse dark:text-gray-500"
              aria-hidden={state === 'done'}
            >
              <Icon path={ICONS.image} className="h-8 w-8" />
            </div>
          ) : null}
        </div>
      )}
      {state === 'done' && broken ? (
        <p className="mt-1 text-xs text-gray-500">
          The image could not be loaded. It is under this chat&apos;s Artifacts.
        </p>
      ) : null}
      {state === 'done' && !image ? (
        <p className="mt-1 text-xs text-gray-500">
          The image was made but is not available to show here; look under this chat&apos;s
          Artifacts.
        </p>
      ) : null}
    </figure>
  );
}
