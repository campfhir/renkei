/**
 * The inline mockup card's behaviour (mockup-card.model.ts), as a person
 * looking at the thread would describe it. The browser spec
 * (mockups.spec.ts) keeps that each format really draws in its frame and
 * that the cards fit a phone's screen.
 */

import {
  INITIAL_CARD_FRAME_HEIGHT,
  INLINE_MAX_HEIGHT,
  cardLayout,
  cardReducer,
  initCard,
  type CardAction,
  type CardState,
} from './mockup-card.model';

const card = (width = 1024, height: number | null = null) => initCard({ width, height });
const run = (actions: CardAction[], from: CardState = card()) => actions.reduce(cardReducer, from);

describe('fitting the design into the card', () => {
  it('scales a desktop design down to the card’s width', () => {
    const layout = cardLayout(run([{ type: 'measured', width: 512 }]));
    expect(layout.scale).toBe(0.5);
    expect(layout.left).toBe(0);
  });

  it('never scales a design narrower than the card up, and sits it in the middle', () => {
    // The 320px logo in a 640px card.
    const layout = cardLayout(run([{ type: 'measured', width: 640 }], card(320)));
    expect(layout.scale).toBe(1);
    expect(layout.left).toBe(160);
  });

  it('draws at full size until the card has been measured', () => {
    expect(cardLayout(card()).scale).toBe(1);
  });

  it('follows the card as it is resized', () => {
    const wide = run([{ type: 'measured', width: 1024 }]);
    expect(cardLayout(wide).scale).toBe(1);
    expect(cardLayout(run([{ type: 'measured', width: 256 }], wide)).scale).toBe(0.25);
  });
});

describe('the card’s height', () => {
  it('starts at 400px, then fits the height the document reports', () => {
    expect(cardLayout(card(320)).frameHeight).toBe(INITIAL_CARD_FRAME_HEIGHT);
    // The 320×80 logo: far shorter than where the frame starts.
    const logo = run([{ type: 'frame-size', height: 80 }], card(320));
    expect(cardLayout(logo).frameHeight).toBe(80);
    expect(cardLayout(logo).shownHeight).toBe(80);
  });

  it('keeps a reported height between 80px and 6000px, rounded up', () => {
    expect(cardLayout(run([{ type: 'frame-size', height: 12 }])).frameHeight).toBe(80);
    expect(cardLayout(run([{ type: 'frame-size', height: 1e6 }])).frameHeight).toBe(6000);
    expect(cardLayout(run([{ type: 'frame-size', height: 200.1 }])).frameHeight).toBe(201);
  });

  it('keeps a height the call fixed, whatever the document reports', () => {
    const fixed = run([{ type: 'frame-size', height: 90 }], card(1024, 300));
    expect(cardLayout(fixed).frameHeight).toBe(300);
  });

  it('shows the scaled height, not the design’s own', () => {
    const state = run([
      { type: 'measured', width: 512 },
      { type: 'frame-size', height: 520 },
    ]);
    expect(cardLayout(state).shownHeight).toBe(260);
    expect(cardLayout(state).cropped).toBe(false);
  });

  it('crops a tall design to its top at 440px, and says so', () => {
    const state = run([
      { type: 'measured', width: 512 },
      { type: 'frame-size', height: 3000 },
    ]);
    expect(cardLayout(state).shownHeight).toBe(INLINE_MAX_HEIGHT);
    expect(cardLayout(state).cropped).toBe(true);
  });

  it('does not call a design cropped that only rounds past the limit', () => {
    const state = run([
      { type: 'measured', width: 1024 },
      { type: 'frame-size', height: INLINE_MAX_HEIGHT + 1 },
    ]);
    expect(cardLayout(state).shownHeight).toBe(INLINE_MAX_HEIGHT);
    expect(cardLayout(state).cropped).toBe(false);
  });
});

describe('opening it full screen', () => {
  it('opens the viewer from the card, and closes it again', () => {
    const open = run([{ type: 'open' }]);
    expect(card().open).toBe(false);
    expect(open.open).toBe(true);
    expect(run([{ type: 'close' }], open).open).toBe(false);
  });

  it('keeps the card’s measure and height while the viewer is open and after', () => {
    const before = run([
      { type: 'measured', width: 512 },
      { type: 'frame-size', height: 520 },
    ]);
    const after = run([{ type: 'open' }, { type: 'close' }], before);
    expect(cardLayout(after)).toEqual(cardLayout(before));
  });
});
