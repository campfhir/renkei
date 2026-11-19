import {
  CTA_SIZE,
  DEFAULT_SIZE,
  EDGE,
  GAP,
  MIN_SIZE,
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
} from './assistant-dock.model';

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const run = (actions: DockAction[], from: DockState = initialDock) =>
  actions.reduce(dockReducer, from);
const measured = run([{ type: 'viewport', size: desktop }]);
const opened = run([{ type: 'open' }], measured);

/** The CTA's centre, where a person presses it. */
const centre = (state: DockState) => {
  const point = ctaPoint(state)!;
  return { x: point.x + CTA_SIZE / 2, y: point.y + CTA_SIZE / 2 };
};

describe('the CTA', () => {
  it('draws nothing until the viewport is measured, then sits in the bottom-right corner', () => {
    expect(ctaPoint(initialDock)).toBeNull();
    expect(windowPlacement(initialDock)).toBeNull();
    expect(ctaPoint(measured)).toEqual({
      x: desktop.width - EDGE - CTA_SIZE,
      y: desktop.height - EDGE - CTA_SIZE,
    });
  });

  it('a press that does not move opens the window, and another collapses it', () => {
    const at = centre(measured);
    const clicked = run(
      [
        { type: 'press', pointer: at },
        { type: 'move', pointer: { x: at.x + 2, y: at.y + 1 } },
        { type: 'release', pointer: { x: at.x + 2, y: at.y + 1 } },
      ],
      measured
    );
    expect(clicked.open).toBe(true);
    expect(clicked.anchor).toBe('bottom-right');
    const again = run(
      [
        { type: 'press', pointer: at },
        { type: 'release', pointer: at },
      ],
      clicked
    );
    expect(again.open).toBe(false);
  });

  it('follows the pointer while dragged, kept on screen, and anchors to the nearest corner', () => {
    const at = centre(measured);
    const dragging = run(
      [
        { type: 'press', pointer: at },
        { type: 'move', pointer: { x: 300, y: 200 } },
      ],
      measured
    );
    expect(isDragging(dragging)).toBe(true);
    // Grabbed by its centre, so its centre is under the pointer.
    expect(ctaPoint(dragging)).toEqual({ x: 300 - CTA_SIZE / 2, y: 200 - CTA_SIZE / 2 });
    const offscreen = run([{ type: 'move', pointer: { x: -500, y: 5000 } }], dragging);
    expect(ctaPoint(offscreen)).toEqual({ x: 0, y: desktop.height - CTA_SIZE });

    const dropped = run([{ type: 'release', pointer: { x: 300, y: 200 } }], dragging);
    expect(dropped.anchor).toBe('top-left');
    expect(dropped.open).toBe(false); // a drag is not a click
    expect(ctaPoint(dropped)).toEqual({ x: EDGE, y: EDGE });
    expect(
      run(
        [
          { type: 'press', pointer: at },
          { type: 'release', pointer: { x: desktop.width - 100, y: 120 } },
        ],
        measured
      ).anchor
    ).toBe('top-right');
  });

  it('a drag taken away leaves it where it was', () => {
    const at = centre(measured);
    const cancelled = run(
      [
        { type: 'press', pointer: at },
        { type: 'move', pointer: { x: 100, y: 100 } },
        { type: 'cancel' },
      ],
      measured
    );
    expect(cancelled.anchor).toBe('bottom-right');
    expect(isDragging(cancelled)).toBe(false);
  });

  it('moves corner to corner from the keyboard', () => {
    expect(cornerToward('bottom-right', 'ArrowUp')).toBe('top-right');
    expect(cornerToward('top-right', 'ArrowLeft')).toBe('top-left');
    expect(cornerToward('top-left', 'ArrowDown')).toBe('bottom-left');
    expect(cornerToward('bottom-left', 'ArrowRight')).toBe('bottom-right');
    expect(run([{ type: 'anchor', corner: 'top-left' }], measured).anchor).toBe('top-left');
  });
});

describe('the window', () => {
  it('opens above a CTA at the bottom, lined up with its outer edge', () => {
    const placement = windowPlacement(opened)!;
    const cta = ctaPoint(opened)!;
    expect(placement.below).toBe(false);
    expect(placement.rect).toEqual({
      left: cta.x + CTA_SIZE - DEFAULT_SIZE.width,
      top: cta.y - GAP - DEFAULT_SIZE.height,
      ...DEFAULT_SIZE,
    });
  });

  it('opens below a CTA anchored at the top, and fits the room under it', () => {
    const top = run([{ type: 'anchor', corner: 'top-left' }], opened);
    const placement = windowPlacement(top)!;
    expect(placement.below).toBe(true);
    expect(placement.alignLeft).toBe(true);
    expect(placement.rect.left).toBe(EDGE);
    expect(placement.rect.top).toBe(EDGE + CTA_SIZE + GAP);
    // A tall window kept from a big screen is cut to what is under the CTA.
    const tall = run([{ type: 'restored', size: { width: 500, height: 2000 } }], top);
    const fitted = windowPlacement(tall)!.rect;
    expect(fitted.top + fitted.height).toBe(desktop.height - EDGE);
    expect(fitted.width).toBe(500);
  });

  it('moves with the CTA while it is dragged, turning toward the middle of the screen', () => {
    const at = centre(opened);
    const dragged = run(
      [
        { type: 'press', pointer: at },
        { type: 'move', pointer: { x: 400, y: 150 } },
      ],
      opened
    );
    const cta = ctaPoint(dragged)!;
    const placement = windowPlacement(dragged)!;
    expect(placement.below).toBe(true);
    expect(placement.rect.left).toBe(cta.x);
    expect(placement.rect.top).toBe(cta.y + CTA_SIZE + GAP);
    // Still open once it lands.
    expect(run([{ type: 'release', pointer: { x: 400, y: 150 } }], dragged).open).toBe(true);
  });

  it('fits a phone: never wider than the room beside the CTA, the size kept for a bigger screen', () => {
    const small = run([{ type: 'viewport', size: phone }], opened);
    const rect = windowPlacement(small)!.rect;
    expect(rect.left).toBe(EDGE);
    expect(rect.width).toBe(phone.width - 2 * EDGE);
    expect(rect.top).toBeGreaterThanOrEqual(EDGE);
    expect(small.size).toEqual(DEFAULT_SIZE);
  });
});

describe('resizing', () => {
  it('moves only the edges away from the CTA', () => {
    expect(freeEdges(opened)).toEqual({ x: 'left', y: 'top' });
    expect(freeEdges(run([{ type: 'anchor', corner: 'top-left' }], opened))).toEqual({
      x: 'right',
      y: 'bottom',
    });
  });

  it('draws an outline that follows the pointer, and the window takes it on release', () => {
    const before = windowPlacement(opened)!.rect;
    const start = { x: before.left, y: before.top };
    const resizing = run(
      [
        { type: 'startResize', handle: { x: true, y: true }, pointer: start },
        { type: 'move', pointer: { x: start.x - 80, y: start.y - 40 } },
      ],
      opened
    );
    // The window waits; the outline shows the new size, its CTA side fixed.
    expect(windowPlacement(resizing)!.rect).toEqual(before);
    expect(resizeOutline(resizing)).toEqual({
      left: before.left - 80,
      top: before.top - 40,
      width: before.width + 80,
      height: before.height + 40,
    });
    const done = run(
      [{ type: 'release', pointer: { x: start.x - 80, y: start.y - 40 } }],
      resizing
    );
    expect(resizeOutline(done)).toBeNull();
    expect(done.size).toEqual({ width: before.width + 80, height: before.height + 40 });
    expect(windowPlacement(done)!.rect.left).toBe(before.left - 80);
  });

  it('an edge handle moves one way; never below the smallest size, nor past the viewport', () => {
    const before = windowPlacement(opened)!.rect;
    const start = { x: before.left, y: before.top };
    const narrow = run(
      [
        { type: 'startResize', handle: { x: true, y: false }, pointer: start },
        { type: 'move', pointer: { x: start.x + 1000, y: start.y + 300 } },
      ],
      opened
    );
    expect(resizeOutline(narrow)).toMatchObject({ width: MIN_SIZE.width, height: before.height });
    const huge = run([{ type: 'move', pointer: { x: -5000, y: -5000 } }], narrow);
    const outline = resizeOutline(huge)!;
    expect(outline.left).toBe(EDGE);
    expect(outline.left + outline.width).toBe(before.left + before.width);
  });

  it('a resize taken away keeps the size it had', () => {
    const before = windowPlacement(opened)!.rect;
    const cancelled = run(
      [
        { type: 'startResize', handle: { x: true, y: true }, pointer: { x: 0, y: 0 } },
        { type: 'move', pointer: { x: -60, y: -60 } },
        { type: 'cancel' },
      ],
      opened
    );
    expect(cancelled.size).toEqual(DEFAULT_SIZE);
    expect(windowPlacement(cancelled)!.rect).toEqual(before);
  });

  it('only resizes an open window, and collapsing ends a resize', () => {
    expect(
      run(
        [{ type: 'startResize', handle: { x: true, y: true }, pointer: { x: 0, y: 0 } }],
        measured
      ).resize
    ).toBeNull();
    const resizing = run(
      [{ type: 'startResize', handle: { x: true, y: true }, pointer: { x: 0, y: 0 } }],
      opened
    );
    expect(run([{ type: 'close' }], resizing).resize).toBeNull();
  });
});

describe('what this browser remembers', () => {
  it('the corner and the size, read back whatever was stored', () => {
    const moved = run(
      [
        { type: 'anchor', corner: 'top-left' },
        { type: 'restored', size: { width: 480.4, height: 600 } },
      ],
      measured
    );
    expect(remembered(moved)).toEqual({ anchor: 'top-left', size: { width: 480, height: 600 } });
    expect(readRemembered(JSON.parse(JSON.stringify(remembered(moved))))).toEqual(
      remembered(moved)
    );
    expect(readRemembered({ anchor: 'middle', size: { width: -1, height: 'x' } })).toEqual({});
    expect(readRemembered(null)).toEqual({});
  });
});
