/**
 * The fullscreen mockup viewer's behaviour (mockup-viewer.model.ts), as a
 * person using it would describe it. The browser spec (mockups.spec.ts)
 * keeps what only a browser shows: the live frame, a real key from inside
 * it reaching the viewer, focus coming back on Escape, and the phone fit.
 */

import {
  INITIAL_FRAME_HEIGHT,
  PAD,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  clampZoom,
  commandForFrameMessage,
  commandForKey,
  copyText,
  frameHeight,
  initViewer,
  movesZoom,
  stageLayout,
  stepped,
  viewerReducer,
  wheelZooms,
  widthButtons,
  zoomLabel,
  type KeyPress,
  type ViewerAction,
  type ViewerCommand,
  type ViewerState,
} from './mockup-viewer.model';

const opened = (width = 1024, height: number | null = null) => initViewer({ width, height });

const run = (actions: ViewerAction[], from: ViewerState = opened()) =>
  actions.reduce(viewerReducer, from);

const zoomIn: ViewerAction = { type: 'zoom-step', direction: 1 };
const zoomOut: ViewerAction = { type: 'zoom-step', direction: -1 };
const reset: ViewerAction = { type: 'zoom-step', direction: 0 };

/** A key or frame message that asks for a change to the viewer (not to close it). */
function actionOf(command: ViewerCommand | null): ViewerAction {
  if (!command || command.type === 'close')
    throw new Error(`expected an action, got ${command?.type}`);
  return command;
}

const key = (k: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe('opening', () => {
  it('opens at 100%, at the width it was designed for, with the hand tool off', () => {
    const state = opened(390);
    expect(zoomLabel(state)).toBe('100%');
    expect(state.viewWidth).toBe(390);
    expect(state.pan).toBe(false);
    expect(state.copied).toBe(false);
  });
});

describe('zoom buttons and the ladder', () => {
  it('zooms in to 125%, and two steps out from there to 90%', () => {
    const inOnce = run([zoomIn]);
    expect(zoomLabel(inOnce)).toBe('125%');
    expect(zoomLabel(run([zoomOut, zoomOut], inOnce))).toBe('90%');
  });

  it('reaches 200% in three steps in, which draws the frame twice as wide', () => {
    const state = run([zoomIn, zoomIn, zoomIn]);
    expect(zoomLabel(state)).toBe('200%');
    const at100 = stageLayout(opened());
    const at200 = stageLayout(state);
    expect((at200.boxWidth - PAD * 2) / (at100.boxWidth - PAD * 2)).toBe(2);
  });

  it('“Reset zoom to 100%” goes back to 100% from anywhere', () => {
    expect(zoomLabel(run([zoomIn, zoomIn, reset]))).toBe('100%');
    expect(zoomLabel(run([zoomOut, zoomOut, zoomOut, reset]))).toBe('100%');
  });

  it('walks every step of the ladder in order, both ways', () => {
    let state = run([{ type: 'fit', stageWidth: 0 }]);
    expect(state.zoom).toBe(ZOOM_MIN);
    const up: number[] = [state.zoom];
    for (let i = 1; i < ZOOM_STEPS.length; i += 1) {
      state = viewerReducer(state, zoomIn);
      up.push(state.zoom);
    }
    expect(up).toEqual(ZOOM_STEPS);
    const down: number[] = [state.zoom];
    for (let i = 1; i < ZOOM_STEPS.length; i += 1) {
      state = viewerReducer(state, zoomOut);
      down.push(state.zoom);
    }
    expect(down).toEqual([...ZOOM_STEPS].reverse());
  });

  it('stops at 400% however many times zoom in is pressed', () => {
    const state = run(Array.from({ length: 20 }, () => zoomIn));
    expect(state.zoom).toBe(ZOOM_MAX);
    expect(zoomLabel(state)).toBe('400%');
  });

  it('stops at 25% however many times zoom out is pressed', () => {
    const state = run(Array.from({ length: 20 }, () => zoomOut));
    expect(state.zoom).toBe(ZOOM_MIN);
    expect(zoomLabel(state)).toBe('25%');
  });

  it('steps from an in-between zoom (after a wheel or Fit) to the next step, not past it', () => {
    expect(stepped(0.8, 1)).toBe(0.9);
    expect(stepped(0.8, -1)).toBe(0.75);
    // A zoom a hair off a step counts as on it.
    expect(stepped(1.0004, 1)).toBe(1.25);
    expect(stepped(0.9996, -1)).toBe(0.9);
  });

  it('clamps any zoom into 25%–400%', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(1.7)).toBe(1.7);
  });

  it('shows the zoom as a whole percentage', () => {
    expect(zoomLabel({ ...opened(), zoom: 0.333 })).toBe('33%');
    expect(zoomLabel({ ...opened(), zoom: 0.6667 })).toBe('67%');
  });
});

describe('zoom keys on the page', () => {
  it('+ and = zoom in, − zooms out, 0 resets', () => {
    expect(commandForKey(key('+'))).toEqual(zoomIn);
    expect(commandForKey(key('='))).toEqual(zoomIn);
    expect(commandForKey(key('-'))).toEqual(zoomOut);
    expect(commandForKey(key('0'))).toEqual(reset);
  });

  it('pressing 0 then + reads 100% then 125%', () => {
    const zoomed = run([zoomOut]);
    const afterZero = viewerReducer(zoomed, actionOf(commandForKey(key('0'))));
    expect(zoomLabel(afterZero)).toBe('100%');
    const afterPlus = viewerReducer(afterZero, actionOf(commandForKey(key('+'))));
    expect(zoomLabel(afterPlus)).toBe('125%');
  });

  it('leaves ctrl/⌘/alt + plus, minus and 0 to the browser’s own page zoom', () => {
    for (const k of ['+', '=', '-', '0']) {
      expect(commandForKey(key(k, { ctrlKey: true }))).toBeNull();
      expect(commandForKey(key(k, { metaKey: true }))).toBeNull();
      expect(commandForKey(key(k, { altKey: true }))).toBeNull();
    }
  });

  it('Escape closes it, with or without a modifier held', () => {
    expect(commandForKey(key('Escape'))).toEqual({ type: 'close' });
    expect(commandForKey(key('Escape', { ctrlKey: true }))).toEqual({ type: 'close' });
  });

  it('ignores every other key', () => {
    for (const k of ['a', '1', 'Enter', ' ', 'ArrowUp', 'Tab']) {
      expect(commandForKey(key(k))).toBeNull();
    }
  });
});

describe('ctrl/⌘ + wheel and pinch', () => {
  it('zooms only with ctrl or ⌘ held; a plain wheel scrolls the stage', () => {
    expect(wheelZooms({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(wheelZooms({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(wheelZooms({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('wheeling up zooms in and wheeling down zooms out, smoothly rather than by steps', () => {
    const up = run([{ type: 'wheel', deltaY: -300 }]);
    expect(up.zoom).toBeGreaterThan(1);
    expect(ZOOM_STEPS).not.toContain(up.zoom);
    expect(run([{ type: 'wheel', deltaY: 100 }]).zoom).toBeLessThan(1);
  });

  it('wheeling the same distance back returns to where it was', () => {
    const state = run([
      { type: 'wheel', deltaY: -120 },
      { type: 'wheel', deltaY: 120 },
    ]);
    expect(state.zoom).toBeCloseTo(1, 10);
  });

  it('adds up quick wheel events rather than losing any between draws', () => {
    const twice = run([
      { type: 'wheel', deltaY: -100 },
      { type: 'wheel', deltaY: -100 },
    ]);
    expect(twice.zoom).toBeCloseTo(run([{ type: 'wheel', deltaY: -200 }]).zoom, 10);
  });

  it('stops at 25% and 400% however far it is wheeled', () => {
    expect(run([{ type: 'wheel', deltaY: -100_000 }]).zoom).toBe(ZOOM_MAX);
    expect(run([{ type: 'wheel', deltaY: 100_000 }]).zoom).toBe(ZOOM_MIN);
  });

  it('holds the middle of the view for steps and wheels (and only those)', () => {
    expect(movesZoom(zoomIn)).toBe(true);
    expect(movesZoom({ type: 'wheel', deltaY: 1 })).toBe(true);
    expect(movesZoom({ type: 'fit', stageWidth: 800 })).toBe(false);
    expect(movesZoom({ type: 'width', width: 390 })).toBe(false);
  });
});

describe('Fit to width', () => {
  it('scales a wide design down to fit the stage, inside its padding', () => {
    // A 1024px design on a 390px phone's stage.
    const state = run([{ type: 'fit', stageWidth: 390 }]);
    expect(state.zoom).toBeCloseTo((390 - PAD * 2) / 1024, 10);
    expect(zoomLabel(state)).toBe('33%');
  });

  it('never blows a design up past 100% when the stage is wider', () => {
    expect(run([{ type: 'fit', stageWidth: 2000 }]).zoom).toBe(1);
  });

  it('never goes below 25%, even on a very narrow stage', () => {
    expect(run([{ type: 'fit', stageWidth: 100 }]).zoom).toBe(ZOOM_MIN);
  });

  it('fits the width being viewed, not the width it was designed at', () => {
    const state = run([
      { type: 'width', width: 390 },
      { type: 'fit', stageWidth: 500 },
    ]);
    expect(state.zoom).toBe(1);
  });
});

describe('width buttons', () => {
  it('offers the width it was designed at, then desktop, tablet and phone', () => {
    expect(widthButtons(opened(1024)).map((b) => b.name)).toEqual([
      'As designed, 1024px wide',
      'Desktop, 1280px wide',
      'Tablet, 768px wide',
      'Phone, 390px wide',
    ]);
  });

  it('drops a preset that repeats the designed width, keeping “As designed”', () => {
    expect(widthButtons(opened(390)).map((b) => b.name)).toEqual([
      'As designed, 390px wide',
      'Desktop, 1280px wide',
      'Tablet, 768px wide',
    ]);
  });

  it('presses the button of the width being viewed, and only that one', () => {
    const atStart = widthButtons(opened(1024));
    expect(atStart.filter((b) => b.pressed).map((b) => b.label)).toEqual(['As designed']);

    const phone = widthButtons(run([{ type: 'width', width: 390 }]));
    expect(phone.filter((b) => b.pressed).map((b) => b.name)).toEqual(['Phone, 390px wide']);
  });

  it('lays the frame out at the chosen width, at the current zoom', () => {
    const state = run([{ type: 'width', width: 390 }]);
    expect(stageLayout(state).frameWidth).toBe(390);
    expect(stageLayout(state).boxWidth).toBe(390 + PAD * 2);
    const zoomed = run([zoomIn, zoomIn, zoomIn], state);
    expect(stageLayout(zoomed).frameWidth).toBe(390);
    expect(stageLayout(zoomed).boxWidth).toBe(780 + PAD * 2);
  });
});

describe('the frame’s height', () => {
  it('starts at 600px and follows the height the document reports', () => {
    expect(frameHeight(opened())).toBe(INITIAL_FRAME_HEIGHT);
    expect(frameHeight(run([{ type: 'frame-size', height: 520 }]))).toBe(520);
  });

  it('rounds a fractional height up, and keeps it between 80px and 6000px', () => {
    expect(frameHeight(run([{ type: 'frame-size', height: 519.2 }]))).toBe(520);
    expect(frameHeight(run([{ type: 'frame-size', height: 10 }]))).toBe(80);
    expect(frameHeight(run([{ type: 'frame-size', height: 99_999 }]))).toBe(6000);
  });

  it('keeps a height the call fixed, whatever the document reports', () => {
    const fixed = opened(1024, 700);
    expect(frameHeight(fixed)).toBe(700);
    expect(frameHeight(run([{ type: 'frame-size', height: 300 }], fixed))).toBe(700);
  });

  it('scales the box on the stage with the zoom, padding included', () => {
    const state = run([{ type: 'frame-size', height: 520 }, zoomIn, zoomIn, zoomIn]);
    expect(stageLayout(state).frameHeight).toBe(520);
    expect(stageLayout(state).boxHeight).toBe(1040 + PAD * 2);
  });
});

describe('messages forwarded from inside the mockup', () => {
  it('a ctrl/⌘ + wheel over the mockup zooms like one over the stage', () => {
    expect(commandForFrameMessage({ type: 'zoom', deltaY: -300 })).toEqual({
      type: 'wheel',
      deltaY: -300,
    });
  });

  it('ctrl/⌘ + = from inside the mockup zooms in to 125%', () => {
    const command = commandForFrameMessage({ type: 'zoom-step', direction: 1 });
    expect(zoomLabel(run([actionOf(command)]))).toBe('125%');
  });

  it('ctrl/⌘ + − and ctrl/⌘ + 0 from inside the mockup step out and reset', () => {
    expect(commandForFrameMessage({ type: 'zoom-step', direction: -1 })).toEqual(zoomOut);
    expect(commandForFrameMessage({ type: 'zoom-step', direction: 0 })).toEqual(reset);
  });

  it('Escape from inside the mockup closes the viewer', () => {
    expect(commandForFrameMessage({ type: 'escape' })).toEqual({ type: 'close' });
  });

  it('the document’s reported height sizes the frame', () => {
    expect(commandForFrameMessage({ type: 'size', height: 520 })).toEqual({
      type: 'frame-size',
      height: 520,
    });
  });
});

describe('the hand tool', () => {
  it('turns on and off from its button', () => {
    const on = run([{ type: 'toggle-pan' }]);
    expect(on.pan).toBe(true);
    expect(run([{ type: 'toggle-pan' }], on).pan).toBe(false);
  });

  it('leaves the zoom and width where they were', () => {
    const before = run([zoomIn, { type: 'width', width: 768 }]);
    const after = run([{ type: 'toggle-pan' }], before);
    expect(after.zoom).toBe(before.zoom);
    expect(after.viewWidth).toBe(768);
  });
});

describe('Copy code', () => {
  it('copies the source alone when there is no extra CSS', () => {
    expect(copyText({ source: '<p>hi</p>', css: '' })).toBe('<p>hi</p>');
  });

  it('copies the CSS after the source, marked', () => {
    expect(copyText({ source: '<p>hi</p>', css: 'p{color:red}' })).toBe(
      '<p>hi</p>\n\n/* css */\np{color:red}'
    );
  });

  it('says “Copied” once the clipboard took it, until the tick runs out', () => {
    const copied = run([{ type: 'copied' }]);
    expect(copied.copied).toBe(true);
    expect(run([{ type: 'copy-reset' }], copied).copied).toBe(false);
  });
});
