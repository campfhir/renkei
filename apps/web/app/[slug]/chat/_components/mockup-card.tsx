'use client';

/**
 * A mockup the model showed (chat_show_mockup), drawn inline: the design
 * in a sandboxed frame, scaled down to the card's width, with its top
 * visible and a click anywhere on it opening the fullscreen viewer
 * (mockup-viewer.tsx). The frame is for looking, not for using — pointer
 * events go to the click target above it — so scrolling the thread past a
 * card never gets caught in a mockup; the viewer is where it is live.
 *
 * The frame loads the route's document (lib/mockups/document.ts), which is
 * laid out at the width the model designed for and measures itself; this
 * scales it by the card's own width, and fits its height to the report.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { MockupRequest } from '@/lib/mockups/request';
import { clampFrameHeight, useFrameMessages, type FrameMessage } from './mockup-frame';
import MockupViewer from './mockup-viewer';

/** How tall the preview may be before it is cropped to its top; the viewer shows the rest. */
const INLINE_MAX_HEIGHT = 440;
/** The frame's height until the document reports its own. */
const INITIAL_FRAME_HEIGHT = 400;

export default function MockupCard({
  tenantId,
  chatId,
  toolUseId,
  request,
}: {
  tenantId: string;
  chatId: string;
  toolUseId: string;
  request: MockupRequest;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [reported, setReported] = useState<number | null>(null);
  // No `src` on the first render, for the reason widget-card.tsx gives: a
  // frame that loads before this component's listener is attached posts
  // its height into the void and the card stays at its guess. The source
  // is set only once the listener is there.
  const [ready, setReady] = useState(false);

  const fixedHeight = request.height;
  const onMessage = useCallback(
    (message: FrameMessage) => {
      if (message.type === 'size' && fixedHeight === null) {
        setReported(clampFrameHeight(message.height));
      }
    },
    [fixedHeight]
  );
  useFrameMessages(frameRef, onMessage);
  useEffect(() => setReady(true), []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setBoxWidth(box.clientWidth);
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const frameHeight = fixedHeight ?? reported ?? INITIAL_FRAME_HEIGHT;
  const scale = boxWidth > 0 ? Math.min(1, boxWidth / request.width) : 1;
  const fullHeight = frameHeight * scale;
  const shownHeight = Math.min(fullHeight, INLINE_MAX_HEIGHT);
  const cropped = fullHeight > INLINE_MAX_HEIGHT + 1;
  const url = chatClient.mockupUrl(tenantId, chatId, toolUseId);

  return (
    <figure className="my-2 max-w-2xl overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <figcaption className="flex items-center gap-2 border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700">
        <Icon path={ICONS.mockup} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate font-medium" title={request.title}>
          {request.title}
        </span>
        <span className="shrink-0 text-gray-400">
          {request.format} · {request.width}px
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open full screen"
          title="Open full screen"
          className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <Icon path={ICONS.expand} className="h-3.5 w-3.5" />
        </button>
      </figcaption>
      <div className="relative bg-gray-50 dark:bg-gray-900">
        <div
          ref={boxRef}
          className="relative mx-auto overflow-hidden"
          style={{ width: '100%', height: shownHeight }}
        >
          <iframe
            ref={frameRef}
            src={ready ? url : undefined}
            sandbox="allow-scripts"
            title={`Mockup: ${request.title}`}
            tabIndex={-1}
            aria-hidden="true"
            loading="lazy"
            style={{
              position: 'absolute',
              top: 0,
              // A design narrower than the card sits in the middle of it.
              left: Math.max(0, (boxWidth - request.width * scale) / 2),
              width: request.width,
              height: frameHeight,
              border: 0,
              background: '#fff',
              pointerEvents: 'none',
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
          {cropped ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/15 to-transparent"
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${request.title} full screen`}
          className="group absolute inset-0 flex cursor-zoom-in items-end justify-center bg-transparent pb-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-500"
        >
          <span className="rounded-full bg-gray-900/80 px-3 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            Click to expand
          </span>
        </button>
      </div>
      {open ? <MockupViewer url={url} request={request} onClose={() => setOpen(false)} /> : null}
    </figure>
  );
}
