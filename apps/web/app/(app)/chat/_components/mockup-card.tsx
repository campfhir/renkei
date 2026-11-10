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
 * What the card decides from those (scale, crop, centring) is its model,
 * mockup-card.model.ts.
 */

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { MockupRequest } from '@/lib/mockups/request';
import { useFrameMessages, type FrameMessage } from './mockup-frame';
import { cardLayout, cardReducer, initCard } from './mockup-card.model';
import MockupViewer from './mockup-viewer';
import SvgSaveButtons from './svg-save-buttons';

export default function MockupCard({
  chatId,
  toolUseId,
  request,
}: {
  chatId: string;
  toolUseId: string;
  request: MockupRequest;
}) {
  const [state, dispatch] = useReducer(cardReducer, request, initCard);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // No `src` on the first render, for the reason widget-card.tsx gives: a
  // frame that loads before this component's listener is attached posts
  // its height into the void and the card stays at its guess. The source
  // is set only once the listener is there.
  const [ready, setReady] = useState(false);

  const onMessage = useCallback((message: FrameMessage) => {
    if (message.type === 'size') dispatch({ type: 'frame-size', height: message.height });
  }, []);
  useFrameMessages(frameRef, onMessage);
  useEffect(() => setReady(true), []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    dispatch({ type: 'measured', width: box.clientWidth });
    const observer = new ResizeObserver(() =>
      dispatch({ type: 'measured', width: box.clientWidth })
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const { scale, frameHeight, shownHeight, cropped, left } = cardLayout(state);
  const url = chatClient.mockupUrl(chatId, toolUseId);

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
        {request.format === 'svg' ? (
          <SvgSaveButtons
            source={request.source}
            name={request.title}
            className="flex shrink-0 items-center gap-0.5"
            buttonClassName="flex items-center gap-1 rounded-md px-1.5 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          />
        ) : null}
        <button
          type="button"
          onClick={() => dispatch({ type: 'open' })}
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
              left,
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
          onClick={() => dispatch({ type: 'open' })}
          aria-label={`Open ${request.title} full screen`}
          className="group absolute inset-0 flex cursor-zoom-in items-end justify-center bg-transparent pb-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-500"
        >
          <span className="rounded-full bg-gray-900/80 px-3 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            Click to expand
          </span>
        </button>
      </div>
      {state.open ? (
        <MockupViewer url={url} request={request} onClose={() => dispatch({ type: 'close' })} />
      ) : null}
    </figure>
  );
}
