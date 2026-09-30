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
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import type { MockupRequest } from '@/lib/mockups/request';
import { clampFrameHeight, useFrameMessages, type FrameMessage } from './mockup-frame';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Space kept around the frame on the stage, in screen pixels. */
const PAD = 24;
const INITIAL_FRAME_HEIGHT = 600;

const PRESETS = [
  { label: 'Desktop', width: 1280 },
  { label: 'Tablet', width: 768 },
  { label: 'Phone', width: 390 },
];

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function stepped(zoom: number, direction: -1 | 1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? ZOOM_MIN;
}

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
  const [viewWidth, setViewWidth] = useState(request.width);
  const [zoom, setZoom] = useState(1);
  const [reported, setReported] = useState<number | null>(null);
  const [pan, setPan] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // The point of the design, in its own pixels, that sat at the middle of
  // the stage when a zoom began — put back at the middle once it has drawn.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const frameHeight = request.height ?? reported ?? INITIAL_FRAME_HEIGHT;

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

  const applyZoom = useCallback(
    (next: number) => {
      const stage = stageRef.current;
      if (stage) {
        const offset = frameOffset(stage);
        anchor.current = {
          x: (stage.scrollLeft + stage.clientWidth / 2 - offset.left - PAD) / zoomRef.current,
          y: (stage.scrollTop + stage.clientHeight / 2 - offset.top - PAD) / zoomRef.current,
        };
      }
      setZoom(clampZoom(next));
    },
    [frameOffset]
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
    setZoom(clampZoom(Math.min(1, (stage.clientWidth - PAD * 2) / viewWidth)));
    stage.scrollTo({ left: 0, top: 0 });
  }, [viewWidth]);
  // On open, and whenever the width being viewed changes: what fits.
  useLayoutEffect(() => {
    if (mounted) fit();
  }, [mounted, fit]);

  const zoomByStep = useCallback(
    (direction: -1 | 0 | 1) => {
      if (direction === 0) applyZoom(1);
      else applyZoom(stepped(zoomRef.current, direction));
    },
    [applyZoom]
  );

  const zoomByWheel = useCallback(
    (deltaY: number) => applyZoom(zoomRef.current * Math.exp(-deltaY * 0.0025)),
    [applyZoom]
  );

  const onFrameMessage = useCallback(
    (message: FrameMessage) => {
      if (message.type === 'size') {
        if (request.height === null) setReported(clampFrameHeight(message.height));
      } else if (message.type === 'zoom') zoomByWheel(message.deltaY);
      else if (message.type === 'zoom-step') zoomByStep(message.direction);
      else onClose();
    },
    [request.height, zoomByWheel, zoomByStep, onClose]
  );
  useFrameMessages(frameRef, onFrameMessage);

  // Keys and ctrl/⌘ + wheel on the page itself; the frame's own are
  // forwarded through onFrameMessage. React's onWheel is passive, and a
  // page zoom cannot be cancelled from a passive listener.
  useEffect(() => {
    if (!mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.ctrlKey || event.metaKey || event.altKey) return;
      else if (event.key === '+' || event.key === '=') zoomByStep(1);
      else if (event.key === '-') zoomByStep(-1);
      else if (event.key === '0') zoomByStep(0);
    };
    window.addEventListener('keydown', onKey);
    const stage = stageRef.current;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomByWheel(event.deltaY);
    };
    stage?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      stage?.removeEventListener('wheel', onWheel);
    };
  }, [mounted, onClose, zoomByStep, zoomByWheel]);

  const copySource = () => {
    const text = request.css ? `${request.source}\n\n/* css */\n${request.css}` : request.source;
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  };

  if (!mounted) return null;

  const presets = [{ label: 'As designed', width: request.width }, ...PRESETS].filter(
    (preset, index, all) =>
      index === 0 || all.findIndex((other) => other.width === preset.width) === index
  );

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
          {presets.map((preset) => (
            <ToolButton
              key={`${preset.label}-${preset.width}`}
              label={`${preset.label}, ${preset.width}px wide`}
              pressed={viewWidth === preset.width}
              onClick={() => setViewWidth(preset.width)}
            >
              {preset.label}
              <span className="text-gray-400">{preset.width}</span>
            </ToolButton>
          ))}
        </div>
        <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
          <ToolButton label="Zoom out" onClick={() => zoomByStep(-1)}>
            <Icon path={ICONS.zoomOut} className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Reset zoom to 100%" onClick={() => zoomByStep(0)}>
            <span data-testid="mockup-zoom" className="w-10 tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => zoomByStep(1)}>
            <Icon path={ICONS.zoomIn} className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Fit to width" onClick={fit}>
            <Icon path={ICONS.group} className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Drag to pan" pressed={pan} onClick={() => setPan((on) => !on)}>
            <Icon path={ICONS.hand} className="h-4 w-4" />
          </ToolButton>
        </div>
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
          style={{ width: viewWidth * zoom + PAD * 2, height: frameHeight * zoom + PAD * 2 }}
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
              width: viewWidth,
              height: frameHeight,
              border: 0,
              background: '#fff',
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              boxShadow: '0 1px 3px rgb(0 0 0 / 0.2), 0 8px 24px rgb(0 0 0 / 0.12)',
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
