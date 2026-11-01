import {
  GAP,
  MARGIN,
  cardStyleFor,
  isTall,
  keyAction,
  narrowEdgeFor,
  placeCard,
  sameBox,
  spotlightFor,
  stepControls,
  topBarCorrection,
} from './overlay.model';

const DESKTOP = { width: 1440, height: 900 };
const CARD = { width: 320, height: 180 };

describe('the spotlight', () => {
  it('stands a little proud of its target on every side', () => {
    expect(spotlightFor({ top: 100, left: 200, width: 50, height: 20 })).toEqual({
      top: 94,
      left: 194,
      width: 62,
      height: 32,
    });
  });

  it('only moves when the target did', () => {
    const box = { top: 1, left: 2, width: 3, height: 4 };
    expect(sameBox(box, { ...box })).toBe(true);
    expect(sameBox(box, { ...box, top: 2 })).toBe(false);
    expect(sameBox(null, box)).toBe(false);
  });

  it('a target taller than the screen is brought to the top, under the top bar, not centred', () => {
    expect(isTall(900, 900)).toBe(true);
    expect(isTall(300, 900)).toBe(false);
    expect(topBarCorrection(0)).toBe(-72);
    expect(topBarCorrection(100)).toBe(0);
  });
});

describe('where the card goes beside the spotlight', () => {
  const spot = { top: 200, left: 600, width: 100, height: 40 };

  it('goes below by default, centred under the target', () => {
    expect(placeCard(spot, CARD, 'auto', DESKTOP)).toEqual({
      top: 200 + 40 + GAP,
      left: 650 - 160,
    });
  });

  it('takes the side the step prefers when it fits', () => {
    expect(placeCard(spot, CARD, 'right', DESKTOP)).toEqual({ top: 130, left: 712 });
    expect(placeCard(spot, CARD, 'left', DESKTOP)).toEqual({ top: 130, left: 600 - GAP - 320 });
  });

  it('falls back to the next side that fits when the preferred one does not', () => {
    const nearTop = { top: 20, left: 600, width: 100, height: 40 };
    // No room above: the card goes below instead.
    expect(placeCard(nearTop, CARD, 'top', DESKTOP).top).toBe(20 + 40 + GAP);
  });

  it('never leaves the screen: clamped to the margin at the edges', () => {
    const corner = { top: 200, left: 0, width: 40, height: 40 };
    expect(placeCard(corner, CARD, 'bottom', DESKTOP).left).toBe(MARGIN);
    const huge = { top: 0, left: 0, width: 1440, height: 900 };
    const placed = placeCard(huge, CARD, 'auto', DESKTOP);
    expect(placed.top).toBe(900 - MARGIN - 180);
  });
});

describe('on a narrow screen', () => {
  const phone = 844;
  const card = 200;

  it('the card spans the bottom edge as a rule', () => {
    expect(narrowEdgeFor({ top: 100, left: 0, width: 300, height: 60 }, card, phone)).toBe(
      'bottom'
    );
  });

  it('it moves to the top when the bottom would cover more than twice as much of the spotlight', () => {
    expect(narrowEdgeFor({ top: 400, left: 0, width: 300, height: 420 }, card, phone)).toBe('top');
  });

  it('is full width at the edge it chose', () => {
    const spot = { top: 1, left: 1, width: 1, height: 1 };
    expect(cardStyleFor({ spot, narrow: true, narrowEdge: 'top', cardPos: null })).toEqual({
      left: MARGIN,
      right: MARGIN,
      top: MARGIN,
    });
    expect(cardStyleFor({ spot, narrow: true, narrowEdge: 'bottom', cardPos: null })).toEqual({
      left: MARGIN,
      right: MARGIN,
      bottom: MARGIN,
    });
  });
});

describe("the card's position", () => {
  const spot = { top: 1, left: 1, width: 1, height: 1 };

  it('has none of its own with nothing spotlit: it sits centred', () => {
    expect(cardStyleFor({ spot: null, narrow: false, narrowEdge: 'bottom', cardPos: null })).toBe(
      undefined
    );
  });

  it('is hidden until it has been measured and placed, then sits where it was placed', () => {
    expect(cardStyleFor({ spot, narrow: false, narrowEdge: 'bottom', cardPos: null })).toEqual({
      top: MARGIN,
      left: MARGIN,
      visibility: 'hidden',
    });
    expect(
      cardStyleFor({ spot, narrow: false, narrowEdge: 'bottom', cardPos: { top: 5, left: 6 } })
    ).toEqual({ top: 5, left: 6 });
  });
});

describe('the keys', () => {
  it('Escape skips, the right arrow goes on, the left arrow goes back', () => {
    expect(keyAction('Escape', 0)).toBe('skip');
    expect(keyAction('ArrowRight', 0)).toBe('next');
    expect(keyAction('ArrowLeft', 2)).toBe('back');
  });

  it('the left arrow does nothing on the first step, and other keys do nothing at all', () => {
    expect(keyAction('ArrowLeft', 0)).toBeNull();
    expect(keyAction('Enter', 1)).toBeNull();
  });
});

describe("the card's controls", () => {
  it('count the steps from one and offer Next without Back on the first', () => {
    expect(stepControls(0, 6)).toEqual({
      counter: '1 of 6',
      counterLabel: 'Step 1 of 6',
      primary: 'Next',
      showBack: false,
      isLast: false,
    });
  });

  it('say Finish on the last step, with Back', () => {
    expect(stepControls(5, 6)).toMatchObject({
      counter: '6 of 6',
      primary: 'Finish',
      showBack: true,
    });
  });

  it('a one-step tour is Finish straight away', () => {
    expect(stepControls(0, 1)).toMatchObject({ primary: 'Finish', showBack: false });
  });
});
