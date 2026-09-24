/**
 * The chart request vocabulary: defaults filled in, every field bounded
 * to its known words or range, a PDF never transparent, and a filename
 * that always ends in the format's own extension.
 */

import { CHART_SOURCE_MAX_CHARS, chartFilename, chartMediaType, parseChartRequest } from './charts';

describe('parseChartRequest', () => {
  it('fills in the defaults around a bare source', () => {
    const parsed = parseChartRequest({ source: 'pie\n "a" : 1' });
    expect(parsed).toEqual({
      ok: true,
      request: {
        source: 'pie\n "a" : 1',
        format: 'png',
        theme: 'default',
        background: '#ffffff',
        scale: 2,
      },
    });
  });

  it('keeps every option it is given', () => {
    const parsed = parseChartRequest({
      source: 'flowchart LR\n A --> B',
      format: 'svg',
      theme: 'dark',
      background: ' #ABC ',
      scale: 3,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request).toMatchObject({
      format: 'svg',
      theme: 'dark',
      background: '#abc',
      scale: 3,
    });
  });

  it('accepts a transparent background for an image and paints a PDF regardless', () => {
    const png = parseChartRequest({ source: 'pie', background: 'transparent' });
    expect(png.ok && png.request.background).toBe('transparent');
    const pdf = parseChartRequest({ source: 'pie', background: 'transparent', format: 'pdf' });
    expect(pdf.ok && pdf.request.background).toBe('#ffffff');
  });

  it('refuses what is not a request', () => {
    for (const value of [null, 'pie', 42, [], { source: '' }, { source: '   ' }, {}]) {
      const parsed = parseChartRequest(value);
      expect(parsed.ok).toBe(false);
    }
  });

  it('refuses a source past the cap', () => {
    const parsed = parseChartRequest({ source: 'x'.repeat(CHART_SOURCE_MAX_CHARS + 1) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toMatch(/at most 50000/);
  });

  it('refuses an unknown format, theme, background or scale, naming the field', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ format: 'jpg' }, /format must be one of png, svg, pdf/],
      [{ format: 1 }, /format/],
      [{ theme: 'solarized' }, /theme must be one of/],
      [{ background: 'white' }, /background/],
      [{ background: '#12345' }, /background/],
      [{ background: 'url(x)' }, /background/],
      [{ scale: 0 }, /scale must be a whole number from 1 to 4/],
      [{ scale: 5 }, /scale/],
      [{ scale: 1.5 }, /scale/],
      [{ scale: '2' }, /scale/],
    ];
    for (const [extra, message] of cases) {
      const parsed = parseChartRequest({ source: 'pie', ...extra });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.message).toMatch(message);
    }
  });
});

describe('chartMediaType', () => {
  it('names each format', () => {
    expect(chartMediaType('png')).toBe('image/png');
    expect(chartMediaType('svg')).toBe('image/svg+xml');
    expect(chartMediaType('pdf')).toBe('application/pdf');
  });
});

describe('chartFilename', () => {
  it('adds the extension, replaces a chart extension, and defaults the name', () => {
    expect(chartFilename('sales', 'png')).toBe('sales.png');
    expect(chartFilename('sales.png', 'pdf')).toBe('sales.pdf');
    expect(chartFilename('plan.mmd', 'svg')).toBe('plan.svg');
    expect(chartFilename('  ', 'png')).toBe('chart.png');
    expect(chartFilename(undefined, 'svg')).toBe('chart.svg');
    expect(chartFilename('.png', 'png')).toBe('chart.png');
  });

  it('leaves an unrelated extension in the name rather than guessing', () => {
    expect(chartFilename('q3.report', 'png')).toBe('q3.report.png');
  });
});
