/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The chart renderer's promises, against a scripted browser: each format
 * is produced the way it says (a standalone SVG, an element screenshot at
 * the asked scale, a PDF page the chart's own size), Mermaid's parse
 * message comes back typed as an invalid diagram, an oversized drawing
 * is refused rather than rasterized, one browser serves every render and
 * exits when idle, concurrency and time are bounded, and shutdown
 * refuses what follows. Then, where a Chromium is on the box, one real
 * render each way — the same headless shell the image bakes in.
 */

import { existsSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import {
  ChartRenderer,
  ChartRenderError,
  chartPageHtml,
  chartScriptSource,
  defaultChartLaunch,
  resolveMermaidBundle,
  type InPageRenderResult,
} from './charts';

const REQUEST = {
  source: 'pie\n "a" : 1',
  format: 'png' as const,
  theme: 'default' as const,
  background: '#ffffff',
  scale: 2,
};

const DRAWN: InPageRenderResult = {
  ok: true,
  diagramType: 'pie',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"></svg>',
  width: 100,
  height: 50,
};

interface FakePage {
  setContent: jest.Mock;
  addScriptTag: jest.Mock;
  evaluate: jest.Mock;
  setViewportSize: jest.Mock;
  locator: jest.Mock;
  pdf: jest.Mock;
  screenshot: jest.Mock;
}

interface FakeContext {
  route: jest.Mock;
  newPage: jest.Mock;
  close: jest.Mock;
  page: FakePage;
}

interface FakeBrowser {
  connected: boolean;
  contexts: FakeContext[];
  isConnected: () => boolean;
  once: jest.Mock;
  newContext: jest.Mock;
  close: jest.Mock;
}

function fakePage(drawn: () => Promise<InPageRenderResult>): FakePage {
  const screenshot = jest.fn(async () => Buffer.from('png-bytes'));
  return {
    setContent: jest.fn(async () => undefined),
    addScriptTag: jest.fn(async () => undefined),
    evaluate: jest.fn(drawn),
    setViewportSize: jest.fn(async () => undefined),
    locator: jest.fn(() => ({ screenshot })),
    pdf: jest.fn(async () => Buffer.from('pdf-bytes')),
    screenshot,
  };
}

function fakeBrowser(drawn: () => Promise<InPageRenderResult> = async () => DRAWN): FakeBrowser {
  const browser: FakeBrowser = {
    connected: true,
    contexts: [],
    isConnected: () => browser.connected,
    once: jest.fn(),
    newContext: jest.fn(async () => {
      const page = fakePage(drawn);
      const context: FakeContext = {
        route: jest.fn(async () => undefined),
        newPage: jest.fn(async () => page),
        close: jest.fn(async () => undefined),
        page,
      };
      browser.contexts.push(context);
      return context;
    }),
    close: jest.fn(async () => {
      browser.connected = false;
    }),
  };
  return browser;
}

function renderer(
  browser: FakeBrowser,
  extra: { idleMs?: number; maxConcurrent?: number; timeoutMs?: number } = {}
): { renderer: ChartRenderer; launch: jest.Mock } {
  const launch = jest.fn(async () => browser as unknown as Browser);
  return {
    renderer: new ChartRenderer({
      launch,
      mermaidBundle: '/bundle/mermaid.min.js',
      idleMs: 60_000,
      ...extra,
    }),
    launch,
  };
}

async function failure(work: Promise<unknown>): Promise<ChartRenderError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ChartRenderError) return error;
    throw error;
  }
  throw new Error('expected a ChartRenderError');
}

describe('ChartRenderer', () => {
  it('refuses every chart, without launching, when there is no Mermaid bundle', async () => {
    const browser = fakeBrowser();
    const launch = jest.fn(async () => browser as unknown as Browser);
    const r = new ChartRenderer({ launch, mermaidBundle: '' });
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('charts_unavailable');
    expect(launch).not.toHaveBeenCalled();
  });

  it('renders an SVG as a standalone file, sized with its padding', async () => {
    const browser = fakeBrowser();
    const { renderer: r } = renderer(browser);
    const out = await r.render({ ...REQUEST, format: 'svg' });
    expect(out.mediaType).toBe('image/svg+xml');
    expect(out.bytes.toString('utf8')).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /);
    expect(out.width).toBe(100 + 32);
    expect(out.height).toBe(50 + 32);
    expect(out.diagramType).toBe('pie');
    // The page never goes anywhere: authored, script injected from disk, offline, routes aborted.
    const context = browser.contexts[0];
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ offline: true, deviceScaleFactor: 1 })
    );
    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(context.page.setContent).toHaveBeenCalledWith(
      chartPageHtml('#ffffff'),
      expect.anything()
    );
    expect(context.page.addScriptTag).toHaveBeenCalledWith({ path: '/bundle/mermaid.min.js' });
    expect(context.page.evaluate).toHaveBeenCalledWith(
      chartScriptSource(REQUEST.source, 'default', '#ffffff')
    );
    expect(context.close).toHaveBeenCalled();
    await r.shutdown();
  });

  it('renders a PNG as an element screenshot at the asked scale, transparent when asked', async () => {
    const browser = fakeBrowser();
    const { renderer: r } = renderer(browser);
    const out = await r.render({ ...REQUEST, scale: 3, background: 'transparent' });
    expect(out.mediaType).toBe('image/png');
    expect(out.bytes.toString('utf8')).toBe('png-bytes');
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ deviceScaleFactor: 3 })
    );
    const page = browser.contexts[0].page;
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 132, height: 82 });
    expect(page.locator).toHaveBeenCalledWith('#chart');
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'png', omitBackground: true })
    );
    await r.shutdown();
  });

  it('renders a PDF as one page the chart’s own size', async () => {
    const browser = fakeBrowser();
    const { renderer: r } = renderer(browser);
    const out = await r.render({ ...REQUEST, format: 'pdf' });
    expect(out.mediaType).toBe('application/pdf');
    expect(out.bytes.toString('utf8')).toBe('pdf-bytes');
    expect(browser.contexts[0].page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        width: '132px',
        height: '82px',
        printBackground: true,
        pageRanges: '1',
      })
    );
    await r.shutdown();
  });

  it('answers Mermaid’s own parse message as an invalid diagram', async () => {
    const browser = fakeBrowser(async () => ({
      ok: false,
      message: 'Parse error on line 2:\n...\nExpecting NODE_STRING, got EOF',
    }));
    const { renderer: r } = renderer(browser);
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('invalid_diagram');
    expect(error.message).toMatch(/Parse error on line 2/);
    expect(browser.contexts[0].close).toHaveBeenCalled();
    await r.shutdown();
  });

  it('refuses a drawing wider than the ceiling as too large, and an empty one as invalid', async () => {
    const wide = fakeBrowser(async () => ({ ...DRAWN, width: 9000 }));
    const { renderer: r1 } = renderer(wide);
    const tooLarge = await failure(r1.render(REQUEST));
    expect(tooLarge.type).toBe('too_large');
    expect(tooLarge.message).toMatch(/9032×82/);
    await r1.shutdown();

    const empty = fakeBrowser(async () => ({ ...DRAWN, width: 0, height: 0 }));
    const { renderer: r2 } = renderer(empty);
    const invalid = await failure(r2.render(REQUEST));
    expect(invalid.type).toBe('invalid_diagram');
    await r2.shutdown();
  });

  it('maps a browser failure to render_failed', async () => {
    const browser = fakeBrowser(async () => {
      throw new Error('Target page, context or browser has been closed');
    });
    const { renderer: r } = renderer(browser);
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('render_failed');
    expect(error.message).toMatch(/has been closed/);
    await r.shutdown();
  });

  it('answers a launch failure as unavailable', async () => {
    const launch = jest.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const r = new ChartRenderer({ launch, mermaidBundle: '/bundle/mermaid.min.js' });
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('charts_unavailable');
  });

  it('launches one browser for many renders and lets it exit when idle', async () => {
    const browser = fakeBrowser();
    const { renderer: r, launch } = renderer(browser, { idleMs: 20 });
    await r.render(REQUEST);
    await r.render({ ...REQUEST, format: 'svg' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.contexts).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(browser.close).toHaveBeenCalledTimes(1);
    // The next chart launches afresh.
    await r.render(REQUEST);
    expect(launch).toHaveBeenCalledTimes(2);
    await r.shutdown();
  });

  it('runs at most maxConcurrent renders at once; the rest wait their turn', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const browser = fakeBrowser(async () => {
      await gate;
      return DRAWN;
    });
    const { renderer: r } = renderer(browser, { maxConcurrent: 2 });
    const renders = [r.render(REQUEST), r.render(REQUEST), r.render(REQUEST)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(browser.newContext).toHaveBeenCalledTimes(2);
    release();
    await Promise.all(renders);
    expect(browser.newContext).toHaveBeenCalledTimes(3);
    await r.shutdown();
  });

  it('abandons a render past the timeout and closes its context', async () => {
    const browser = fakeBrowser(() => new Promise<InPageRenderResult>(() => undefined));
    const { renderer: r } = renderer(browser, { timeoutMs: 30 });
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('timeout');
    expect(error.message).toMatch(/did not render within/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await r.shutdown();
  });

  it('refuses after shutdown and closes the browser it had', async () => {
    const browser = fakeBrowser();
    const { renderer: r } = renderer(browser);
    await r.render(REQUEST);
    await r.shutdown();
    expect(browser.close).toHaveBeenCalledTimes(1);
    const error = await failure(r.render(REQUEST));
    expect(error.type).toBe('charts_unavailable');
  });
});

describe('chartScriptSource', () => {
  it('is a self-contained expression with the __name shim and the arguments inlined', () => {
    const script = chartScriptSource('pie\n "a" : 1', 'dark', 'transparent');
    expect(script).toMatch(/^\(\(\) => \{ const __name = \(fn\) => fn; return \(/);
    expect(script).toContain('"pie\\n \\"a\\" : 1", "dark", "transparent"');
    expect(script).toContain('mermaid.parse(');
    expect(script).toContain('mermaid.render(');
  });
});

describe('resolveMermaidBundle', () => {
  it('finds this package’s own Mermaid bundle', () => {
    const found = resolveMermaidBundle();
    expect(found).toMatch(/mermaid[/\\]dist[/\\]mermaid\.min\.js$/);
    expect(existsSync(found ?? '')).toBe(true);
  });

  it('honors an explicit path only when it exists', () => {
    const before = process.env.SANDBOX_MERMAID_BUNDLE;
    process.env.SANDBOX_MERMAID_BUNDLE = '/nowhere/mermaid.min.js';
    try {
      expect(resolveMermaidBundle()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.SANDBOX_MERMAID_BUNDLE;
      else process.env.SANDBOX_MERMAID_BUNDLE = before;
    }
  });
});

// A real render, where a Chromium is on the box: the pinned executable
// (SANDBOX_BROWSER_EXECUTABLE), else the headless shell Playwright installs
// under its default browsers path — the very binary the sandbox image
// bakes in. Skipped, not failed, where neither is present.
const CHROMIUM_CANDIDATES = [
  process.env.SANDBOX_BROWSER_EXECUTABLE ?? '',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter((candidate) => candidate && existsSync(candidate));
const withChromium = CHROMIUM_CANDIDATES.length > 0 ? describe : describe.skip;

withChromium('with a real Chromium', () => {
  const executable = CHROMIUM_CANDIDATES[0];
  let before: string | undefined;
  let real: ChartRenderer;

  beforeAll(() => {
    before = process.env.SANDBOX_BROWSER_EXECUTABLE;
    process.env.SANDBOX_BROWSER_EXECUTABLE = executable;
    real = new ChartRenderer({ launch: defaultChartLaunch });
  });

  afterAll(async () => {
    await real.shutdown();
    if (before === undefined) delete process.env.SANDBOX_BROWSER_EXECUTABLE;
    else process.env.SANDBOX_BROWSER_EXECUTABLE = before;
  });

  it('draws a bar chart to PNG, SVG and PDF', async () => {
    const source =
      'xychart-beta\n  title "Tickets by week"\n  x-axis [W1, W2, W3]\n  y-axis "Count" 0 --> 50\n  bar [12, 30, 45]';
    const png = await real.render({ ...REQUEST, source });
    expect(png.diagramType).toBe('xychart');
    // PNG signature, and a 700×500 chart at scale 2 plus padding.
    expect(png.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(png.width).toBe(732);
    expect(png.height).toBe(532);

    const svg = await real.render({ ...REQUEST, source, format: 'svg' });
    expect(svg.bytes.toString('utf8')).toMatch(/<svg[^>]* width="700"/);
    expect(svg.bytes.toString('utf8')).toContain('Tickets by week');

    const pdf = await real.render({ ...REQUEST, source, format: 'pdf' });
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60_000);

  it('answers a broken diagram with Mermaid’s message', async () => {
    const error = await failure(real.render({ ...REQUEST, source: 'flowchart LR\n  A --> ' }));
    expect(error.type).toBe('invalid_diagram');
    expect(error.message).toMatch(/Parse error/);
  }, 60_000);
});
