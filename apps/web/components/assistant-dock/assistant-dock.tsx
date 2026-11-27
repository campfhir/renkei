'use client';

/**
 * The assistant dock: one floating button — the CTA — above everything in
 * the app, which opens and collapses a window that floats over the page.
 * Any page can put its own assistant in that window; the dock draws only
 * while one has.
 *
 * Mounted once, around the app's pages (app/(app)/layout.tsx):
 *
 *   <AssistantDockProvider>{children}</AssistantDockProvider>
 *
 * A page puts its assistant in the window, for as long as it is mounted:
 *
 *   <AssistantDockPanel id="pipeline-assistant" title="Pipeline assistant">
 *     <MyAssistant />
 *   </AssistantDockPanel>
 *
 * Its children render through a portal into the window, so they keep the
 * page's own state and context; the window is kept mounted while
 * collapsed, so nothing is lost by collapsing it. With more than one
 * panel mounted, the last one shows. `useAssistantSlot` is the same as a
 * hook (it hands back the element to portal into), and `useAssistantDock`
 * opens, collapses or toggles the window from anywhere under the provider
 * — a button that asks the assistant something opens it first.
 *
 * The CTA is dragged to any corner, and the window — open or not — goes
 * with it, opening toward the middle of the screen (below a CTA at the
 * top); its edges away from the CTA resize it, an outline showing the
 * size until the pointer lets go. Shift+an arrow key moves the focused
 * CTA corner to corner; Escape collapses the window. Where it sits and
 * its size are this browser's own (localStorage). What the dock decides
 * is assistant-dock.model.ts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import {
  CTA_SIZE,
  cornerToward,
  ctaPoint,
  dockReducer,
  freeEdges,
  initialDock,
  isDragging,
  readRemembered,
  remembered,
  resizeOutline,
  windowPlacement,
  type DockAction,
  type DockState,
  type Handle,
} from './assistant-dock.model';

const STORAGE_KEY = 'renkei.assistant-dock';
/** Above everything the app draws, modals and menus included. */
const LAYER = 'z-[2147483000]';

interface Slot {
  id: string;
  title: string;
}

interface DockContext {
  state: DockState;
  dispatch: (action: DockAction) => void;
  slots: Slot[];
  register: (slot: Slot) => () => void;
  /** The window's body, which the active panel portals into. */
  body: HTMLElement | null;
}

const Context = createContext<DockContext | null>(null);

export interface AssistantDockControls {
  /** False outside the provider, or while no page has a panel in the dock. */
  available: boolean;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** The active panel's title. */
  title: string | null;
}

/** Open, collapse or toggle the dock's window from anywhere under the provider. */
export function useAssistantDock(): AssistantDockControls {
  const context = useContext(Context);
  const dispatch = context?.dispatch;
  const open = useCallback(() => dispatch?.({ type: 'open' }), [dispatch]);
  const close = useCallback(() => dispatch?.({ type: 'close' }), [dispatch]);
  const toggle = useCallback(() => dispatch?.({ type: 'toggle' }), [dispatch]);
  const active = context?.slots[context.slots.length - 1] ?? null;
  return {
    available: Boolean(active),
    isOpen: Boolean(context?.state.open && active),
    open,
    close,
    toggle,
    title: active?.title ?? null,
  };
}

/**
 * Puts a page's assistant in the dock while the calling component is
 * mounted. `target` is the window's body while this slot is the one
 * showing (portal the assistant into it), else null.
 */
export function useAssistantSlot(slot: Slot): AssistantDockControls & {
  target: HTMLElement | null;
  active: boolean;
} {
  const context = useContext(Context);
  const register = context?.register;
  const { id, title } = slot;
  useEffect(() => register?.({ id, title }), [register, id, title]);
  const controls = useAssistantDock();
  const active = context?.slots[context.slots.length - 1]?.id === id;
  return { ...controls, active, target: active ? (context?.body ?? null) : null };
}

/** A page's assistant, drawn in the dock's floating window. */
export function AssistantDockPanel({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const { target } = useAssistantSlot({ id, title });
  return target ? createPortal(children, target) : null;
}

export function AssistantDockProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(dockReducer, initialDock);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [body, setBody] = useState<HTMLElement | null>(null);

  const register = useCallback((slot: Slot) => {
    setSlots((list) => [...list.filter((s) => s.id !== slot.id), slot]);
    return () => setSlots((list) => list.filter((s) => s.id !== slot.id));
  }, []);

  // A page that leaves takes its window with it.
  const empty = slots.length === 0;
  useEffect(() => {
    if (empty) dispatch({ type: 'close' });
  }, [empty]);

  const value = useMemo(
    () => ({ state, dispatch, slots, register, body }),
    [state, slots, register, body]
  );
  return (
    <Context.Provider value={value}>
      {children}
      {empty ? null : <DockFrame onBody={setBody} />}
    </Context.Provider>
  );
}

const CURSOR: Record<string, string> = {
  'left-top': 'cursor-nwse-resize',
  'right-bottom': 'cursor-nwse-resize',
  'right-top': 'cursor-nesw-resize',
  'left-bottom': 'cursor-nesw-resize',
};

function DockFrame({ onBody }: { onBody: (element: HTMLElement | null) => void }) {
  const context = useContext(Context);
  const cta = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const state = context?.state ?? initialDock;
  const dispatch = context?.dispatch;
  const title = context?.slots[context.slots.length - 1]?.title ?? 'Assistant';

  // The part of the page the person can see. iOS Safari keeps the layout
  // viewport — and window.innerHeight — when the keyboard opens and lets the
  // keys cover its bottom; only the visual viewport shrinks (and scrolls).
  // The dock is sized to it, and its layer moved onto it (below), so the
  // window and its input stay above the keyboard.
  const [offset, setOffset] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!dispatch) return;
    const visual = window.visualViewport;
    const measure = () => {
      const width = document.documentElement.clientWidth || window.innerWidth;
      dispatch({
        type: 'viewport',
        size: visual
          ? { width: Math.min(width, visual.width), height: visual.height }
          : { width, height: window.innerHeight },
      });
      const left = visual?.offsetLeft ?? 0;
      const top = visual?.offsetTop ?? 0;
      setOffset((was) => (was.left === left && was.top === top ? was : { left, top }));
    };
    measure();
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) dispatch({ type: 'restored', ...readRemembered(JSON.parse(raw)) });
    } catch {
      // Nothing remembered (private window, blocked storage): the defaults.
    }
    setMounted(true);
    window.addEventListener('resize', measure);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
    };
  }, [dispatch]);

  // Where it sits and its size, once a gesture ends.
  const settled = !state.drag && !state.resize;
  const keep = JSON.stringify(remembered(state));
  useEffect(() => {
    if (!mounted || !settled) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, keep);
    } catch {
      // Not remembered this time; it still works.
    }
  }, [mounted, settled, keep]);

  if (!mounted || !dispatch) return null;
  const point = ctaPoint(state);
  const placement = windowPlacement(state);
  const edges = freeEdges(state);
  const outline = resizeOutline(state);
  if (!point || !placement || !edges) return null;
  const dragging = isDragging(state);
  const gesture = dragging || state.resize !== null;
  // Snapping to a corner glides; following the pointer does not.
  const glide = gesture ? '' : 'motion-safe:transition-[left,top] motion-safe:duration-200';
  // Pointer positions in the layer's own coordinates (see the offset above).
  const at = (e: ReactPointerEvent) => ({
    x: e.clientX - offset.left,
    y: e.clientY - offset.top,
  });

  const capture = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const gestureHandlers = {
    onPointerMove: (e: ReactPointerEvent) => dispatch({ type: 'move', pointer: at(e) }),
    onPointerUp: (e: ReactPointerEvent) => dispatch({ type: 'release', pointer: at(e) }),
    onPointerCancel: () => dispatch({ type: 'cancel' }),
    onLostPointerCapture: () => dispatch({ type: 'cancel' }),
  };
  const resizeHandle = (handle: Handle) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      capture(e);
      dispatch({ type: 'startResize', handle, pointer: at(e) });
    },
    ...gestureHandlers,
  });

  const onCtaKey = (e: ReactKeyboardEvent) => {
    if (
      e.shiftKey &&
      (e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight')
    ) {
      e.preventDefault();
      dispatch({ type: 'anchor', corner: cornerToward(state.anchor, e.key) });
    } else if (e.key === 'Escape' && state.open) {
      dispatch({ type: 'close' });
    }
  };
  const onWindowKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (state.resize) dispatch({ type: 'cancel' });
    else {
      dispatch({ type: 'close' });
      cta.current?.focus();
    }
  };

  const rect = placement.rect;
  const corner = `${edges.x}-${edges.y}`;

  return createPortal(
    <div
      className={`pointer-events-none fixed top-0 left-0 ${LAYER} ${gesture ? 'select-none' : ''}`}
      data-testid="assistant-dock"
      // The transform makes this layer the box its fixed children are placed
      // in, laid over the visible part of the page.
      style={{
        width: state.viewport?.width,
        height: state.viewport?.height,
        transform: `translate(${offset.left}px, ${offset.top}px)`,
      }}
    >
      <section
        role="dialog"
        aria-modal="false"
        aria-label={title}
        id="assistant-dock-window"
        hidden={!state.open}
        onKeyDown={onWindowKey}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        className={`pointer-events-auto fixed flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-900 shadow-2xl dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 ${glide} ${state.open ? 'flex' : 'hidden'}`}
      >
        <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <Icon path={ICONS.sparkles} className="size-4 text-blue-600 dark:text-blue-400" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={`Collapse the ${title}`}
            onClick={() => {
              dispatch({ type: 'close' });
              cta.current?.focus();
            }}
            className="inline-flex size-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.close} className="size-4" />
          </button>
        </header>
        <div ref={onBody} className="relative min-h-0 flex-1" />

        {/* The edges away from the CTA, and the corner between them. */}
        <div
          aria-hidden
          data-testid="assistant-dock-resize-x"
          {...resizeHandle({ x: true, y: false })}
          className={`absolute top-0 h-full w-2 cursor-ew-resize touch-none ${edges.x === 'left' ? 'left-0' : 'right-0'}`}
        />
        <div
          aria-hidden
          data-testid="assistant-dock-resize-y"
          {...resizeHandle({ x: false, y: true })}
          className={`absolute left-0 h-2 w-full cursor-ns-resize touch-none ${edges.y === 'top' ? 'top-0' : 'bottom-0'}`}
        />
        <div
          aria-hidden
          data-testid="assistant-dock-resize-corner"
          {...resizeHandle({ x: true, y: true })}
          className={`absolute size-4 touch-none ${CURSOR[corner]} ${edges.x === 'left' ? 'left-0' : 'right-0'} ${edges.y === 'top' ? 'top-0' : 'bottom-0'}`}
        />
      </section>

      {outline ? (
        <div
          aria-hidden
          data-testid="assistant-dock-outline"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height,
          }}
          className="pointer-events-none fixed rounded-xl border-2 border-dashed border-blue-500 bg-blue-500/5"
        />
      ) : null}

      <button
        ref={cta}
        type="button"
        aria-expanded={state.open}
        aria-controls="assistant-dock-window"
        aria-label={state.open ? `Collapse the ${title}` : `Open the ${title}`}
        title={`${title} — drag to move it to another corner`}
        style={{ left: point.x, top: point.y, width: CTA_SIZE, height: CTA_SIZE }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          capture(e);
          dispatch({ type: 'press', pointer: at(e) });
        }}
        {...gestureHandlers}
        // From the keyboard (a pointer's click is its press and release).
        onClick={(e) => {
          if (e.detail === 0) dispatch({ type: 'toggle' });
        }}
        onKeyDown={onCtaKey}
        className={`pointer-events-auto fixed inline-flex touch-none items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-offset-2 hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:ring-offset-gray-950 ${dragging ? 'cursor-grabbing shadow-2xl' : 'cursor-grab'} ${glide}`}
      >
        <Icon path={state.open ? ICONS.close : ICONS.sparkles} className="size-6" />
      </button>
    </div>,
    document.body
  );
}
