/**
 * The pure half of saving an SVG the model wrote (svg-image.ts): which
 * blocks are SVG at all (and so get Save as PNG / SVG under them), the
 * size the image is drawn at, the PNG's pixels and the file's name.
 * Parsing the markup (a truncated SVG refused) and drawing the PNG are
 * the browser's, and stay in e2e/svg-save.spec.ts.
 */

import { drawnSize, fileStem, looksLikeSvg, pngPixels } from './svg-image';

describe('which blocks are an SVG', () => {
  it('a block that is one <svg> document is', () => {
    expect(looksLikeSvg('<svg viewBox="0 0 10 10"></svg>')).toBe(true);
    expect(looksLikeSvg('  \n<svg>\n</svg>')).toBe(true);
    expect(looksLikeSvg('<SVG xmlns="http://www.w3.org/2000/svg"/>')).toBe(true);
  });

  it('an XML prolog, comments and a doctype may come first', () => {
    expect(
      looksLikeSvg(
        '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>'
      )
    ).toBe(true);
  });

  it('code, HTML with an svg inside, and a tag that merely starts with svg are not', () => {
    expect(looksLikeSvg('console.log("hi");')).toBe(false);
    expect(looksLikeSvg('<div><svg></svg></div>')).toBe(false);
    expect(looksLikeSvg('<svgfoo></svgfoo>')).toBe(false);
    expect(looksLikeSvg('')).toBe(false);
  });

  it('a block cut off mid-stream still looks like one (the save then says it is not complete)', () => {
    expect(
      looksLikeSvg('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><circle cx="5"')
    ).toBe(true);
  });
});

describe('the size the image is drawn at', () => {
  const size = (width: string | null, height: string | null, viewBox: string | null) =>
    drawnSize({ width, height, viewBox });

  it('is the width and height when both are pixels', () => {
    expect(size('200', '80', '0 0 10 10')).toEqual({ width: 200, height: 80 });
    expect(size('200px', ' 80 ', null)).toEqual({ width: 200, height: 80 });
  });

  it("is the viewBox's when the root has no pixel size", () => {
    expect(size(null, null, '0 0 120 120')).toEqual({ width: 120, height: 120 });
    expect(size('100%', '50em', '0,0,300,150')).toEqual({ width: 300, height: 150 });
  });

  it("follows the viewBox's shape when only one side is given", () => {
    expect(size('100', null, '0 0 200 100')).toEqual({ width: 100, height: 50 });
    expect(size(null, '100', '0 0 200 100')).toEqual({ width: 200, height: 100 });
  });

  it('is a 512 square with nothing to go on, keeping a side that was given', () => {
    expect(size(null, null, null)).toEqual({ width: 512, height: 512 });
    expect(size('64', null, 'nonsense')).toEqual({ width: 64, height: 512 });
    expect(size('0', '-4', '0 0 0 10')).toEqual({ width: 512, height: 512 });
  });
});

describe("the PNG's pixels", () => {
  it('are twice the drawing, for a sharp image on a dense screen', () => {
    expect(pngPixels({ width: 120, height: 120 })).toEqual({ width: 240, height: 240 });
    expect(pngPixels({ width: 200, height: 80 })).toEqual({ width: 400, height: 160 });
  });

  it('shrink so neither side passes 4096', () => {
    expect(pngPixels({ width: 4000, height: 1000 })).toEqual({ width: 4096, height: 1024 });
  });

  it('are never less than a pixel', () => {
    expect(pngPixels({ width: 0.1, height: 0.1 }, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe("the file's name", () => {
  it('is the title, lower-case, with anything but letters and digits as one dash', () => {
    expect(fileStem('Renkei logo')).toBe('renkei-logo');
    expect(fileStem('  Q3 — Revenue / Costs!  ')).toBe('q3-revenue-costs');
  });

  it('is "image" when the title has nothing usable', () => {
    expect(fileStem('')).toBe('image');
    expect(fileStem('★★★')).toBe('image');
  });

  it('is cut at 60 characters', () => {
    expect(fileStem('a'.repeat(80))).toHaveLength(60);
  });
});
