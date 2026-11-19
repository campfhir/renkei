/**
 * The assistant dock (assistant-dock.tsx): a floating button — the CTA —
 * above everything, anchored in a corner of the viewport, that opens and
 * collapses a window a page fills with its assistant (useAssistantSlot).
 *
 * What it decides, in viewport pixels:
 * - where the CTA sits: its corner, or under the pointer while dragged;
 *   let go, it anchors to the nearest corner. A press that does not move
 *   is a click: it opens or collapses the window.
 * - where the window sits: beside the CTA, opening toward the middle of
 *   the screen — below a CTA in the top half, above one in the bottom
 *   half; leftward or rightward the same way — so it moves with the CTA
 *   while dragged, and is never larger than the room on its side.
 * - resizing: only the window's edges away from the CTA move; while the
 *   pointer is down an outline shows the size it will take, and letting
 *   go takes it. Sizes are kept as the person left them and fitted to
 *   the viewport whenever it is drawn, so a smaller window never loses
 *   the size chosen on a larger one.
 *
 * Tested in assistant-dock.model.test.ts.
 */

import { recordOrNull } from '@renkei/guards';

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The CTA's diameter. */
export const CTA_SIZE = 56;
/** Room kept between the CTA or the window and the viewport's edge. */
export const EDGE = 16;
/** Room between the CTA and its window. */
export const GAP = 12;
export const MIN_SIZE: Size = { width: 300, height: 260 };
export const DEFAULT_SIZE: Size = { width: 420, height: 580 };
/** How far a press moves before it is a drag, not a click. */
export const DRAG_THRESHOLD = 4;

/** Which of the window's free edges a resize handle moves. */
export interface Handle {
  x: boolean;
  y: boolean;
}

export interface DockState {
  /** Null until the page has measured it (the first render in a browser). */
  viewport: Size | null;
  anchor: Corner;
  open: boolean;
  /** As the person last left it; fitted to the viewport where it is drawn. */
  size: Size;
  drag: {
    start: Point;
    /** Where on the CTA it was grabbed. */
    grab: Point;
    /** The CTA's top-left corner now. */
    at: Point;
    moved: boolean;
  } | null;
  resize: {
    handle: Handle;
    start: Point;
    /** The window's size when the resize began, as drawn. */
    from: Size;
    /** The size the outline shows, and the window takes on release. */
    draft: Size;
  } | null;
}

export type DockAction =
  | { type: 'viewport'; size: Size }
  /** What this browser remembered (anchor and size), once on load. */
  | { type: 'restored'; anchor?: Corner; size?: Size }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'toggle' }
  /** The pointer went down on the CTA. */
  | { type: 'press'; pointer: Point }
  /** The pointer went down on a resize handle. */
  | { type: 'startResize'; handle: Handle; pointer: Point }
  | { type: 'move'; pointer: Point }
  | { type: 'release'; pointer: Point }
  /** The pointer was taken away (pointercancel, Escape): nothing changes. */
  | { type: 'cancel' }
  /** From the keyboard: anchor in this corner. */
  | { type: 'anchor'; corner: Corner };

export const initialDock: DockState = {
  viewport: null,
  anchor: 'bottom-right',
  open: false,
  size: DEFAULT_SIZE,
  drag: null,
  resize: null,
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

export function isCorner(value: unknown): value is Corner {
  return typeof value === 'string' && CORNERS.some((corner) => corner === value);
}

/** The CTA's top-left corner when it sits in a corner. */
export function cornerPoint(corner: Corner, viewport: Size): Point {
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  return {
    x: left ? EDGE : Math.max(EDGE, viewport.width - EDGE - CTA_SIZE),
    y: top ? EDGE : Math.max(EDGE, viewport.height - EDGE - CTA_SIZE),
  };
}

/** The corner nearest the CTA's centre. */
export function nearestCorner(at: Point, viewport: Size): Corner {
  const top = at.y + CTA_SIZE / 2 < viewport.height / 2;
  const left = at.x + CTA_SIZE / 2 < viewport.width / 2;
  return `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`;
}

/** The CTA's top-left corner now: under the pointer while dragged, else its corner. */
export function ctaPoint(state: DockState): Point | null {
  if (!state.viewport) return null;
  if (state.drag?.moved) return state.drag.at;
  return cornerPoint(state.anchor, state.viewport);
}

export function isDragging(state: DockState): boolean {
  return Boolean(state.drag?.moved);
}

export interface Placement {
  rect: Rect;
  /** The window opens below the CTA (it is in the top half). */
  below: boolean;
  /** The window's left edge lines up with the CTA's (it is in the left half). */
  alignLeft: boolean;
  /** The most room on the CTA's side of the screen. */
  max: Size;
}

/** The window beside the CTA at `point`, at `size` fitted to the room there. */
function place(point: Point, size: Size, viewport: Size): Placement {
  const below = point.y + CTA_SIZE / 2 < viewport.height / 2;
  const alignLeft = point.x + CTA_SIZE / 2 < viewport.width / 2;
  const max = {
    width: Math.max(0, alignLeft ? viewport.width - EDGE - point.x : point.x + CTA_SIZE - EDGE),
    height: Math.max(
      0,
      below ? viewport.height - EDGE - (point.y + CTA_SIZE + GAP) : point.y - GAP - EDGE
    ),
  };
  const width = clamp(size.width, Math.min(MIN_SIZE.width, max.width), max.width);
  const height = clamp(size.height, Math.min(MIN_SIZE.height, max.height), max.height);
  return {
    rect: {
      left: alignLeft ? point.x : point.x + CTA_SIZE - width,
      top: below ? point.y + CTA_SIZE + GAP : point.y - GAP - height,
      width,
      height,
    },
    below,
    alignLeft,
    max,
  };
}

/** Where the window is drawn now: beside the CTA, at the size kept, fitted. */
export function windowPlacement(state: DockState): Placement | null {
  const point = ctaPoint(state);
  if (!point || !state.viewport) return null;
  return place(point, state.size, state.viewport);
}

/** The outline a resize draws: the size the window takes when the pointer lets go. */
export function resizeOutline(state: DockState): Rect | null {
  const point = ctaPoint(state);
  if (!point || !state.viewport || !state.resize) return null;
  return place(point, state.resize.draft, state.viewport).rect;
}

/** The window's edges a resize moves: the ones away from the CTA. */
export function freeEdges(state: DockState): { x: 'left' | 'right'; y: 'top' | 'bottom' } | null {
  const placement = windowPlacement(state);
  if (!placement) return null;
  return { x: placement.alignLeft ? 'right' : 'left', y: placement.below ? 'bottom' : 'top' };
}

/** The size a resize's pointer asks for, fitted to the room on the CTA's side. */
function resized(state: DockState, pointer: Point): Size | null {
  const resize = state.resize;
  const placement = windowPlacement(state);
  if (!resize || !placement) return null;
  const dx = pointer.x - resize.start.x;
  const dy = pointer.y - resize.start.y;
  const width = resize.handle.x
    ? resize.from.width + (placement.alignLeft ? dx : -dx)
    : resize.from.width;
  const height = resize.handle.y
    ? resize.from.height + (placement.below ? dy : -dy)
    : resize.from.height;
  return {
    width: Math.round(
      clamp(width, Math.min(MIN_SIZE.width, placement.max.width), placement.max.width)
    ),
    height: Math.round(
      clamp(height, Math.min(MIN_SIZE.height, placement.max.height), placement.max.height)
    ),
  };
}

export function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case 'viewport':
      return { ...state, viewport: action.size };
    case 'restored':
      return {
        ...state,
        anchor: action.anchor ?? state.anchor,
        size:
          action.size && action.size.width > 0 && action.size.height > 0
            ? { width: Math.round(action.size.width), height: Math.round(action.size.height) }
            : state.size,
      };
    case 'open':
      return { ...state, open: true };
    case 'close':
      return { ...state, open: false, resize: null };
    case 'toggle':
      return { ...state, open: !state.open, resize: null };
    case 'press': {
      const point = ctaPoint(state);
      if (!point || state.resize) return state;
      return {
        ...state,
        drag: {
          start: action.pointer,
          grab: { x: action.pointer.x - point.x, y: action.pointer.y - point.y },
          at: point,
          moved: false,
        },
      };
    }
    case 'startResize': {
      const placement = windowPlacement(state);
      if (!placement || !state.open || state.drag) return state;
      const from = { width: placement.rect.width, height: placement.rect.height };
      return {
        ...state,
        resize: { handle: action.handle, start: action.pointer, from, draft: from },
      };
    }
    case 'move': {
      if (state.drag && state.viewport) {
        const drag = state.drag;
        const moved =
          drag.moved ||
          Math.hypot(action.pointer.x - drag.start.x, action.pointer.y - drag.start.y) >=
            DRAG_THRESHOLD;
        if (!moved) return state;
        const viewport = state.viewport;
        return {
          ...state,
          drag: {
            ...drag,
            moved: true,
            at: {
              x: clamp(action.pointer.x - drag.grab.x, 0, viewport.width - CTA_SIZE),
              y: clamp(action.pointer.y - drag.grab.y, 0, viewport.height - CTA_SIZE),
            },
          },
        };
      }
      if (state.resize) {
        const draft = resized(state, action.pointer);
        return draft ? { ...state, resize: { ...state.resize, draft } } : state;
      }
      return state;
    }
    case 'release': {
      if (state.drag) {
        const moving = dockReducer(state, { type: 'move', pointer: action.pointer });
        const drag = moving.drag;
        if (!drag?.moved || !state.viewport) {
          return { ...state, drag: null, open: !state.open };
        }
        return { ...moving, drag: null, anchor: nearestCorner(drag.at, state.viewport) };
      }
      if (state.resize) {
        const draft = resized(state, action.pointer) ?? state.resize.draft;
        return { ...state, resize: null, size: draft };
      }
      return state;
    }
    case 'cancel':
      return { ...state, drag: null, resize: null };
    case 'anchor':
      return { ...state, anchor: action.corner, drag: null };
  }
}

/** The corner Shift+an arrow key moves the CTA to from `corner`. */
export function cornerToward(
  corner: Corner,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
): Corner {
  const top = corner.startsWith('top');
  const left = corner.endsWith('left');
  const vertical =
    key === 'ArrowUp' ? 'top' : key === 'ArrowDown' ? 'bottom' : top ? 'top' : 'bottom';
  const horizontal =
    key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : left ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}

/** What this browser keeps between visits: the corner and the size. */
export function remembered(state: DockState): { anchor: Corner; size: Size } {
  return { anchor: state.anchor, size: state.size };
}

/** A remembered value read back, whatever it holds. */
export function readRemembered(value: unknown): { anchor?: Corner; size?: Size } {
  const record = recordOrNull(value);
  if (!record) return {};
  const size = recordOrNull(record.size);
  const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const width = number(size?.width);
  const height = number(size?.height);
  return {
    ...(isCorner(record.anchor) ? { anchor: record.anchor } : {}),
    ...(width > 0 && height > 0 ? { size: { width, height } } : {}),
  };
}
