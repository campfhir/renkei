import { placeFloating } from './floating';

const viewport = { width: 1000, height: 800 };

describe('placeFloating', () => {
  it('goes below the anchor when there is room, aligned to its start', () => {
    const box = placeFloating(
      { top: 100, bottom: 120, left: 50, right: 250 },
      { width: 300, height: 200 },
      viewport,
      { align: 'start' }
    );
    expect(box).toEqual({ top: 124, left: 50, placement: 'below' });
  });

  it('flips above when the anchor is near the bottom edge', () => {
    const box = placeFloating(
      { top: 700, bottom: 720, left: 50, right: 250 },
      { width: 300, height: 200 },
      viewport,
      { align: 'start' }
    );
    expect(box.placement).toBe('above');
    expect(box.top).toBe(700 - 4 - 200);
  });

  it('prefers above for a composer and still drops below at the top of the window', () => {
    const above = placeFloating(
      { top: 600, bottom: 660, left: 0, right: 600 },
      { width: 600, height: 150 },
      viewport,
      { align: 'start', prefer: 'above', gap: 6 }
    );
    expect(above.placement).toBe('above');
    expect(above.top).toBe(600 - 6 - 150);
    const below = placeFloating(
      { top: 20, bottom: 80, left: 0, right: 600 },
      { width: 600, height: 150 },
      viewport,
      { align: 'start', prefer: 'above', gap: 6 }
    );
    expect(below.placement).toBe('below');
    expect(below.top).toBe(86);
  });

  it('lines an end-aligned menu up with the anchor’s right edge and keeps it on screen', () => {
    const box = placeFloating(
      { top: 10, bottom: 30, left: 980, right: 996 },
      { width: 208, height: 100 },
      viewport,
      { align: 'end' }
    );
    expect(box.left).toBe(1000 - 8 - 208);
    expect(box.placement).toBe('below');
  });

  it('takes the roomier side when neither fits whole', () => {
    const box = placeFloating(
      { top: 300, bottom: 320, left: 0, right: 100 },
      { width: 100, height: 700 },
      viewport,
      { align: 'start' }
    );
    expect(box.placement).toBe('below');
    expect(box.top).toBeGreaterThanOrEqual(8);
  });
});
