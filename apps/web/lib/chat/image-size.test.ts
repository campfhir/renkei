/**
 * The shape of a requested picture: pixels and ratios are read strictly, a
 * ratio becomes about a megapixel of multiples of 16, a size a model
 * rejects falls back to the nearest one every model takes, and the loading
 * outline is the shape asked for even from half-arrived JSON.
 */

import {
  nearestStandardSize,
  parseAspectRatio,
  parseSize,
  requestedShape,
  sizeFromRatio,
  sizeLadder,
  skeletonRatio,
} from './image-size';

describe('parseSize', () => {
  it('reads WIDTHxHEIGHT in either spelling of x, within range', () => {
    expect(parseSize('1792x1024')).toEqual({ width: 1792, height: 1024 });
    expect(parseSize(' 1024 × 1536 ')).toEqual({ width: 1024, height: 1536 });
    expect(parseSize('1024X1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('refuses anything else, and sides out of range', () => {
    for (const bad of [
      'auto',
      '1024',
      '1024x',
      'x1024',
      '10x10',
      '9000x1024',
      '1024x0',
      1024,
      null,
      '1e3x1e3',
    ]) {
      expect(parseSize(bad)).toBeNull();
    }
  });
});

describe('parseAspectRatio', () => {
  it('reads w:h and w/h, decimals included', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('3/2')).toBeCloseTo(1.5);
    expect(parseAspectRatio('1.5:1')).toBeCloseTo(1.5);
  });

  it('refuses zero, negatives and words', () => {
    for (const bad of ['0:0', '16:0', '-1:2', 'wide', '16', '', null]) {
      expect(parseAspectRatio(bad)).toBeNull();
    }
  });
});

describe('sizeFromRatio', () => {
  it('makes about a megapixel of multiples of 16', () => {
    for (const ratio of [1, 16 / 9, 9 / 16, 3 / 2, 2 / 3, 21 / 9]) {
      const { width, height } = sizeFromRatio(ratio);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(width * height).toBeGreaterThan(900_000);
      expect(width * height).toBeLessThan(1_200_000);
      expect(width / height).toBeCloseTo(ratio, 1);
    }
    expect(sizeFromRatio(16 / 9)).toEqual({ width: 1360, height: 768 });
  });

  it('holds a ratio to the 3:1 every model allows', () => {
    const wide = sizeFromRatio(10);
    expect(wide.width / wide.height).toBeLessThanOrEqual(3.05);
    const tall = sizeFromRatio(0.05);
    expect(tall.height / tall.width).toBeLessThanOrEqual(3.05);
  });
});

describe('nearestStandardSize', () => {
  it('picks landscape, portrait or square by shape', () => {
    expect(nearestStandardSize({ width: 1792, height: 1024 })).toBe('1536x1024');
    expect(nearestStandardSize({ width: 768, height: 1360 })).toBe('1024x1536');
    expect(nearestStandardSize({ width: 1100, height: 1000 })).toBe('1024x1024');
  });
});

describe('requestedShape', () => {
  it('is no shape when nothing, or auto, is asked', () => {
    expect(requestedShape({})).toEqual({ ok: true, size: null });
    expect(requestedShape({ size: 'auto' })).toEqual({ ok: true, size: null });
    expect(requestedShape({ size: '  ', aspectRatio: '' })).toEqual({ ok: true, size: null });
  });

  it('lets size win over aspectRatio, and derives pixels from a ratio alone', () => {
    expect(requestedShape({ size: '1792x1024', aspectRatio: '1:1' })).toEqual({
      ok: true,
      size: { width: 1792, height: 1024 },
    });
    expect(requestedShape({ aspectRatio: '16:9' })).toEqual({
      ok: true,
      size: { width: 1360, height: 768 },
    });
  });

  it('refuses what it does not understand, saying which formats it takes', () => {
    const size = requestedShape({ size: 'huge' });
    expect(!size.ok && size.reason).toMatch(/WIDTHxHEIGHT/);
    const ratio = requestedShape({ aspectRatio: 'wide' });
    expect(!ratio.ok && ratio.reason).toMatch(/width:height/);
  });
});

describe('sizeLadder', () => {
  it('is just auto when no size was asked', () => {
    expect(sizeLadder(null, true)).toEqual([null]);
    expect(sizeLadder(null, false)).toEqual([null]);
  });

  it('tries the size, then the nearest standard one, then auto for a model that can choose', () => {
    const asked = { width: 1792, height: 1024 };
    expect(sizeLadder(asked, true)).toEqual(['1792x1024', '1536x1024', null]);
    expect(sizeLadder(asked, false)).toEqual(['1792x1024', '1536x1024']);
  });

  it('does not repeat a size that is already standard', () => {
    expect(sizeLadder({ width: 1024, height: 1024 }, true)).toEqual(['1024x1024', null]);
  });
});

describe('skeletonRatio', () => {
  it('is the shape asked for, from size or from aspectRatio', () => {
    expect(skeletonRatio({ size: '1536x1024' })).toBeCloseTo(1.5);
    expect(skeletonRatio({ aspectRatio: '9:16' })).toBeCloseTo(9 / 16, 1);
  });

  it('reads half-arrived JSON', () => {
    expect(skeletonRatio({}, '{"filename": "a.png", "size": "1024x1536", "qual')).toBeCloseTo(
      2 / 3
    );
    expect(skeletonRatio({}, '{"aspectRatio": "16:9"')).toBeCloseTo(1360 / 768);
  });

  it('is square when nothing usable was asked', () => {
    expect(skeletonRatio({})).toBe(1);
    expect(skeletonRatio(null, '{"size": "wide"')).toBe(1);
    expect(skeletonRatio('nonsense')).toBe(1);
  });
});
