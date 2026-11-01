/**
 * The fullscreen mockup viewer's state (mockup-viewer.tsx): the width the
 * design is being viewed at, the zoom, the hand tool, the height the
 * document reported, and the "Copied" tick.
 *
 * The component keeps what only a browser has — the stage's scroll and
 * size, the zoom's anchor point, the timers, the clipboard — and turns each
 * key, ctrl/⌘ + wheel, button and message from the framed document into an
 * action here. What the viewer decides from them — which keys zoom, how far
 * a step or a wheel goes, where zoom stops, what Fit picks, which width
 * button is pressed, what the toolbar's percentage says — is here, and
 * tested in mockup-viewer.model.test.ts.
 */

import { clampFrameHeight } from '@/lib/mockups/message';
import type { MockupRequest } from '@/lib/mockups/request';
import type { FrameMessage } from './mockup-frame';

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Space kept around the frame on the stage, in screen pixels. */
export const PAD = 24;
/** The frame's height until the document reports its own. */
export const INITIAL_FRAME_HEIGHT = 600;
/** How much one pixel of wheel travel zooms by: e^(-deltaY × this). */
const WHEEL_RATE = 0.0025;

export const WIDTH_PRESETS = [
  { label: 'Desktop', width: 1280 },
  { label: 'Tablet', width: 768 },
  { label: 'Phone', width: 390 },
];

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The next step up or down the zoom ladder from wherever the zoom is now. */
export function stepped(zoom: number, direction: -1 | 1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? ZOOM_MIN;
}

export interface ViewerState {
  /** The width the model designed for: the first width button. */
  designWidth: number;
  /** The call's fixed height, or null to follow what the document reports. */
  fixedHeight: number | null;
  viewWidth: number;
  zoom: number;
  reportedHeight: number | null;
  /** The hand tool: a drag pans the stage instead of reaching the mockup. */
  pan: boolean;
  copied: boolean;
}

export type ViewerAction =
  /** −1 a step out, 1 a step in, 0 back to 100%. */
  | { type: 'zoom-step'; direction: -1 | 0 | 1 }
  /** Ctrl/⌘ + wheel or a trackpad pinch, on the stage or forwarded by the mockup. */
  | { type: 'wheel'; deltaY: number }
  /** Fit the width being viewed into a stage this wide (screen pixels). */
  | { type: 'fit'; stageWidth: number }
  | { type: 'width'; width: number }
  | { type: 'toggle-pan' }
  | { type: 'frame-size'; height: number }
  | { type: 'copied' }
  | { type: 'copy-reset' };

/** What a key or a frame message asks of the viewer: an action, or to close. */
export type ViewerCommand = ViewerAction | { type: 'close' };

export function initViewer(request: Pick<MockupRequest, 'width' | 'height'>): ViewerState {
  return {
    designWidth: request.width,
    fixedHeight: request.height,
    viewWidth: request.width,
    zoom: 1,
    reportedHeight: null,
    pan: false,
    copied: false,
  };
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'zoom-step':
      return {
        ...state,
        zoom: action.direction === 0 ? 1 : clampZoom(stepped(state.zoom, action.direction)),
      };
    case 'wheel':
      return { ...state, zoom: clampZoom(state.zoom * Math.exp(-action.deltaY * WHEEL_RATE)) };
    case 'fit':
      // Never blown up past 100%: a design narrower than the stage is shown at its size.
      return {
        ...state,
        zoom: clampZoom(Math.min(1, (action.stageWidth - PAD * 2) / state.viewWidth)),
      };
    case 'width':
      return { ...state, viewWidth: action.width };
    case 'toggle-pan':
      return { ...state, pan: !state.pan };
    case 'frame-size':
      if (state.fixedHeight !== null) return state;
      return { ...state, reportedHeight: clampFrameHeight(action.height) };
    case 'copied':
      return { ...state, copied: true };
    case 'copy-reset':
      return { ...state, copied: false };
  }
}

/** Whether an action may move the zoom (the component then holds the view's middle). */
export function movesZoom(action: ViewerAction): boolean {
  return action.type === 'zoom-step' || action.type === 'wheel';
}

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * A key pressed on the page while the viewer is up. Escape always closes;
 * + (or =), − and 0 zoom only on their own — with ctrl/⌘/alt they are the
 * browser's own page zoom and shortcuts, and left to it.
 */
export function commandForKey(press: KeyPress): ViewerCommand | null {
  if (press.key === 'Escape') return { type: 'close' };
  if (press.ctrlKey || press.metaKey || press.altKey) return null;
  if (press.key === '+' || press.key === '=') return { type: 'zoom-step', direction: 1 };
  if (press.key === '-') return { type: 'zoom-step', direction: -1 };
  if (press.key === '0') return { type: 'zoom-step', direction: 0 };
  return null;
}

/** A wheel over the stage zooms only with ctrl/⌘ held (a pinch arrives that way); else it scrolls. */
export function wheelZooms(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * What the framed document says (document.ts forwards what it would
 * otherwise swallow while it has the keyboard or the pointer).
 */
export function commandForFrameMessage(message: FrameMessage): ViewerCommand {
  switch (message.type) {
    case 'size':
      return { type: 'frame-size', height: message.height };
    case 'zoom':
      return { type: 'wheel', deltaY: message.deltaY };
    case 'zoom-step':
      return { type: 'zoom-step', direction: message.direction };
    case 'escape':
      return { type: 'close' };
  }
}

/** The toolbar's zoom readout. */
export function zoomLabel(state: ViewerState): string {
  return `${Math.round(state.zoom * 100)}%`;
}

export function frameHeight(state: ViewerState): number {
  return state.fixedHeight ?? state.reportedHeight ?? INITIAL_FRAME_HEIGHT;
}

/**
 * The frame is laid out at the width being viewed and scaled by the zoom;
 * the box around it on the stage is the scaled size plus the padding, so
 * the stage scrolls over exactly what is drawn.
 */
export function stageLayout(state: ViewerState): {
  frameWidth: number;
  frameHeight: number;
  boxWidth: number;
  boxHeight: number;
} {
  const height = frameHeight(state);
  return {
    frameWidth: state.viewWidth,
    frameHeight: height,
    boxWidth: state.viewWidth * state.zoom + PAD * 2,
    boxHeight: height * state.zoom + PAD * 2,
  };
}

export interface WidthButton {
  label: string;
  width: number;
  /** The button's accessible name. */
  name: string;
  pressed: boolean;
}

/**
 * The width buttons: the width it was designed at first, then desktop,
 * tablet and phone — leaving out any that repeats a width already offered.
 */
export function widthButtons(state: ViewerState): WidthButton[] {
  const all = [{ label: 'As designed', width: state.designWidth }, ...WIDTH_PRESETS];
  return all
    .filter(
      (preset, index) =>
        index === 0 || all.findIndex((other) => other.width === preset.width) === index
    )
    .map((preset) => ({
      ...preset,
      name: `${preset.label}, ${preset.width}px wide`,
      pressed: state.viewWidth === preset.width,
    }));
}

/** What "Copy code" puts on the clipboard: the source, and its CSS after it when there is any. */
export function copyText(request: Pick<MockupRequest, 'source' | 'css'>): string {
  return request.css ? `${request.source}\n\n/* css */\n${request.css}` : request.source;
}
