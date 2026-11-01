'use client';

/**
 * A mockup at full screen: the same document as the card, live, on a
 * stage the person can zoom and pan, and — because a design is only as
 * good as the widths it survives — set to a phone's, a tablet's or a
 * desktop's width to see it reflow.
 *
 * Zoom is a CSS scale on the frame, so what is drawn is the real page at
 * any size and a click lands where it looks like it does. It keeps the
 * middle of the view where it was, and works from the buttons, from + − 0,
 * and from ctrl/⌘ + wheel or a trackpad pinch — including while the mockup
 * itself has the pointer, which its own document forwards (document.ts).
 * Pan is the stage's own scrolling, plus a hand tool that turns a drag
 * into a scroll for the moments a mockup's own controls are in the way.
 *
 * Portalled to <body> like the house modal (components/modal.tsx), for the
 * same reasons, and closes on Escape or its own button — not on a click
 * beside it, since a stray click while panning must not throw the view away.
 *
 * What it decides — which keys zoom, the zoom ladder and its ends, Fit,
 * the width buttons, what the frame's messages do — is its model,
 * mockup-viewer.model.ts; this keeps the stage's scroll, the anchor a zoom
 * holds, the clipboard and the event wiring.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import type { MockupRequest } from '@/lib/mockups/request';
import { useFrameMessages, type FrameMessage } from './mockup-frame';
import {
  PAD,
  commandForFrameMessage,
  commandForKey,
  copyText,
  initViewer,
  movesZoom,
  stageLayout,
  viewerReducer,
  wheelZooms,
  widthButtons,
  zoomLabel,
  type ViewerCommand,
} from './mockup-viewer.model';
import SvgSaveButtons from './svg-save-buttons';
import { clientLogger } from '@/lib/client-logger';

function ToolButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-gray-200 dark:hover:bg-gray-800 ${
        pressed ? 'bg-gray-200 dark:bg-gray-800' : ''
      }`}
    >
      {children}
    </button>
  );
}

export default function MockupViewer({
  url,
  request,
  onClose,
}: {
  url: string;
  request: MockupRequest;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [state, dispatch] = useReducer(viewerReducer, request, initViewer);
  const { zoom, viewWidth, pan, copied } = state;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The zoom as drawn: what the stage's scroll is measured against.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // The point of the design, in its own pixels, that sat at the middle of
  // the stage when a zoom began — put back at the middle once it has drawn.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const layout = stageLayout(state);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Keyboard focus goes into the viewer and comes back to whatever opened
  // it; the page behind stops scrolling while it is up.
  useEffect(() => {
    if (!mounted) return;
    const before = document.activeElement;
    rootRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (before instanceof HTMLElement) before.focus();
    };
  }, [mounted]);

  // Where the frame's box starts inside the stage's scrolling content: the
  // auto margin that centres a narrow design moves it sideways, so it is
  // measured, not assumed. (It sits at the top, never centred vertically:
  // the document reports its height a moment after it loads, and a frame
  // that recentred then would jump under the pointer.)
  const frameOffset = useCallback((stage: HTMLElement) => {
    const sizer = sizerRef.current;
    if (!sizer) return { left: 0, top: 0 };
    const at = sizer.getBoundingClientRect();
    const from = stage.getBoundingClientRect();
    return {
      left: at.left - from.left + stage.scrollLeft,
      top: at.top - from.top + stage.scrollTop,
    };
  }, []);

  // Every zoom from a button, key, wheel or the frame comes through here,
  // and holds the middle of the view; Escape from the frame or a key closes.
  const run = useCallback(
    (command: ViewerCommand) => {
      if (command.type === 'close') {
        onClose();
        return;
      }
      const stage = stageRef.current;
      if (stage && movesZoom(command)) {
        const offset = frameOffset(stage);
        anchor.current = {
          x: (stage.scrollLeft + stage.clientWidth / 2 - offset.left - PAD) / zoomRef.current,
          y: (stage.scrollTop + stage.clientHeight / 2 - offset.top - PAD) / zoomRef.current,
        };
      }
      dispatch(command);
    },
    [frameOffset, onClose]
  );

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const held = anchor.current;
    anchor.current = null;
    if (!stage || !held) return;
    const offset = frameOffset(stage);
    stage.scrollLeft = offset.left + PAD + held.x * zoom - stage.clientWidth / 2;
    stage.scrollTop = offset.top + PAD + held.y * zoom - stage.clientHeight / 2;
  }, [zoom, frameOffset]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Fit goes to the top left, not to where an earlier zoom was held: a
    // zoom that changed nothing (already at the end of the ladder) leaves
    // its anchor unspent, and it must not pull the fitted view away.
    anchor.current = null;
    dispatch({ type: 'fit', stageWidth: stage.clientWidth });
    stage.scrollTo({ left: 0, top: 0 });
  }, []);
  // On open, and whenever the width being viewed changes: what fits.
  useLayoutEffect(() => {
    if (mounted) fit();
  }, [mounted, viewWidth, fit]);

  const onFrameMessage = useCallback(
    (message: FrameMessage) => run(commandForFrameMessage(message)),
    [run]
  );
  useFrameMessages(frameRef, onFrameMessage);

  // Keys and ctrl/⌘ + wheel on the page itself; the frame's own are
  // forwarded through onFrameMessage. React's onWheel is passive, and a
  // page zoom cannot be cancelled from a passive listener.
  useEffect(() => {
    if (!mounted) return;
    const onKey = (event: KeyboardEvent) => {
      const command = commandForKey(event);
      if (command) run(command);
    };
    window.addEventListener('keydown', onKey);
    const stage = stageRef.current;
    const onWheel = (event: WheelEvent) => {
      if (!wheelZooms(event)) return;
      event.preventDefault();
      run({ type: 'wheel', deltaY: event.deltaY });
    };
    stage?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      stage?.removeEventListener('wheel', onWheel);
    };
  }, [mounted, run]);

  const copySource = () => {
    void navigator.clipboard.writeText(copyText(request)).then(
      () => {
        dispatch({ type: 'copied' });
        window.setTimeout(() => dispatch({ type: 'copy-reset' }), 1500);
      },
      (error: unknown) => clientLogger.warn('chat/mockup', 'could not copy the source', error)
    );
  };

  if (!mounted) return null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Mockup: ${request.title}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-gray-100 outline-none dark:bg-gray-950"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 bg-white px-3 py-1.5 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={request.title}>
          {request.title}
        </h2>
        <div role="group" aria-label="Width" className="flex items-center gap-0.5">
          {widthButtons(state).map((preset) => (
            <ToolButton
              key={`${preset.label}-${preset.width}`}
              label={preset.name}
              pressed={preset.pressed}
              onClick={() => dispatch({ type: 'width', width: preset.width })}
            >
              {preset.label}
              <span className="text-gray-400">{preset.width}</span>
            </ToolButton>
          ))}
        </div>
        <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
          <ToolButton label="Zoom out" onClick={() => run({ type: 'zoom-step', direction: -1 })}>
            <Icon path={ICONS.zoomOut} className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            label="Reset zoom to 100%"
            onClick={() => run({ type: 'zoom-step', direction: 0 })}
          >
            <span data-testid="mockup-zoom" className="w-10 tabular-nums">
              {zoomLabel(state)}
            </span>
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => run({ type: 'zoom-step', direction: 1 })}>
            <Icon path={ICONS.zoomIn} className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Fit to width" onClick={fit}>
            <Icon path={ICONS.group} className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            label="Drag to pan"
            pressed={pan}
            onClick={() => dispatch({ type: 'toggle-pan' })}
          >
            <Icon path={ICONS.hand} className="h-4 w-4" />
          </ToolButton>
        </div>
        {request.format === 'svg' ? (
          <SvgSaveButtons
            source={request.source}
            name={request.title}
            className="flex items-center gap-0.5"
            buttonClassName="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
          />
        ) : null}
        <ToolButton label="Copy the code" onClick={copySource}>
          <Icon path={copied ? ICONS.check : ICONS.copy} className="h-4 w-4" />
          {copied ? 'Copied' : 'Copy code'}
        </ToolButton>
        <ToolButton label="Close" onClick={onClose}>
          <Icon path={ICONS.close} className="h-4 w-4" />
        </ToolButton>
      </div>
      <div ref={stageRef} className="flex min-h-0 flex-1 items-start overflow-auto">
        <div
          ref={sizerRef}
          className="relative mx-auto shrink-0"
          style={{ width: layout.boxWidth, height: layout.boxHeight }}
        >
          <iframe
            ref={frameRef}
            src={url}
            sandbox="allow-scripts"
            title={`Mockup: ${request.title}`}
            style={{
              position: 'absolute',
              left: PAD,
              top: PAD,
              width: layout.frameWidth,
              height: layout.frameHeight,
              border: 0,
              background: '#fff',
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              boxShadow: '0 1px 3px rgb(0 0 0 / 0.2), 0 8px 24px rgb(0 0 0 / 0.12)',
              // With the hand tool on, the frame takes no pointer at all.
              // The pan layer above it paints nothing, and Chrome routes a
              // press by what was drawn: over a sandboxed frame (a process
              // of its own) it could keep sending the drag to the frame,
              // and the stage would not move.
              pointerEvents: pan ? 'none' : undefined,
            }}
          />
          {pan ? (
            <div
              data-testid="mockup-pan"
              className="absolute inset-0 z-10 cursor-grab active:cursor-grabbing"
              onPointerDown={(event) => {
                const stage = stageRef.current;
                if (!stage) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  x: event.clientX,
                  y: event.clientY,
                  left: stage.scrollLeft,
                  top: stage.scrollTop,
                };
              }}
              onPointerMove={(event) => {
                const stage = stageRef.current;
                const start = drag.current;
                if (!stage || !start) return;
                stage.scrollLeft = start.left - (event.clientX - start.x);
                stage.scrollTop = start.top - (event.clientY - start.y);
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
