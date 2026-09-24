/**
 * Charts: Mermaid text in, an SVG, PNG or PDF out — rendered in this
 * worker's own headless Chromium, the same binary the sandbox browser
 * uses (browser.ts), because Mermaid lays a diagram out with a real DOM
 * and real font metrics, and nothing in Node measures text the way a
 * browser does.
 *
 * What keeps this narrower than the browser:
 *
 *  - Nothing reaches the network. The page is authored here
 *    (`setContent`), the Mermaid bundle is injected from this package's
 *    own node_modules, and every request the page could still make — an
 *    image a label names, a font a theme names — is aborted by a
 *    catch-all route on the context. No proxy is needed because there is
 *    nothing to proxy.
 *  - Mermaid runs at its `strict` security level: HTML in labels is
 *    sanitized, scripts and click bindings are dropped.
 *  - One browser, launched lazily on the first chart and closed after
 *    CHART_IDLE_MS without one; each render gets a fresh context (its own
 *    device scale factor) that is closed when the bytes are in hand; at
 *    most CHART_MAX_CONCURRENT renders run at once and a render past
 *    CHART_RENDER_TIMEOUT_MS is abandoned. A diagram wider or taller than
 *    CHART_MAX_DIMENSION_PX is refused rather than rasterized.
 *
 * A diagram Mermaid cannot parse is answered with Mermaid's own message —
 * line, caret and expected tokens — so the model can correct the text and
 * try again, rather than a bare "failed".
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import {
  CHART_IDLE_MS,
  CHART_MAX_CONCURRENT,
  CHART_MAX_DIMENSION_PX,
  CHART_PADDING_PX,
  CHART_RENDER_TIMEOUT_MS,
  chartMediaType,
  type ChartRequest,
} from '@renkei/connector-sandbox';
import { logger } from './logger';

export type ChartErrorType =
  'charts_unavailable' | 'invalid_diagram' | 'render_failed' | 'timeout' | 'too_large';

export class ChartRenderError extends Error {
  constructor(
    readonly type: ChartErrorType,
    message: string
  ) {
    super(message);
    this.name = 'ChartRenderError';
  }
}

export interface ChartRendered {
  bytes: Buffer;
  mediaType: string;
  /** The diagram's own size in CSS pixels, padding included. */
  width: number;
  height: number;
  /** What Mermaid took the text to be: `flowchart-v2`, `xychart`, `gantt`, `pie`, … */
  diagramType: string;
}

/** The verbs the HTTP surface dispatches to — an interface so the server can be tested against a double. */
export interface ChartVerbs {
  render(request: ChartRequest): Promise<ChartRendered>;
}

/** The subset of a launched browser the renderer relies on — the test seam. */
export type LaunchChartBrowser = () => Promise<Browser>;

export interface ChartRendererDeps {
  /** Default: playwright-core's chromium, headless, no proxy (the page has no network anyway). */
  launch?: LaunchChartBrowser;
  /** Default: `mermaid/dist/mermaid.min.js` from this package's dependencies. */
  mermaidBundle?: string;
  idleMs?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}

/**
 * Where the Mermaid browser bundle is: an explicit SANDBOX_MERMAID_BUNDLE,
 * else resolved from this package's own dependencies (the process runs
 * with the package as its working directory, under pnpm and in the
 * image), else found by walking up from there. Null when nowhere — the
 * renderer then refuses every chart with "unavailable" rather than
 * failing on the first one.
 */
export function resolveMermaidBundle(cwd = process.cwd()): string | null {
  const explicit = process.env.SANDBOX_MERMAID_BUNDLE?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  try {
    return createRequire(join(cwd, 'package.json')).resolve('mermaid/dist/mermaid.min.js');
  } catch {
    // Not a dependency of whatever package the working directory is; walk up.
  }
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Chromium's own executable resolution, unless the image pins one (SANDBOX_BROWSER_EXECUTABLE, shared with browser.ts). */
export function defaultChartLaunch(): Promise<Browser> {
  const executablePath = process.env.SANDBOX_BROWSER_EXECUTABLE?.trim() || undefined;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
    ],
  });
}

/** What the in-page render answers: the SVG and its natural size, or Mermaid's complaint. */
export interface InPageRenderResult {
  ok: boolean;
  diagramType?: string;
  svg?: string;
  width?: number;
  height?: number;
  message?: string;
}

/**
 * Shipped to the page as source text (see browser-page-script.ts for why
 * not `page.evaluate(fn)` under tsx). It parses first so a bad diagram is
 * reported as such, renders into the container, then pins the SVG to its
 * own viewBox size — Mermaid emits `width="100%"` with a `max-width`, which
 * is right for a web page and wrong for a file — and measures it.
 */
export function chartScriptSource(source: string, theme: string, background: string): string {
  return `(() => { const __name = (fn) => fn; return (${renderChartInPage.toString()})(${JSON.stringify(source)}, ${JSON.stringify(theme)}, ${JSON.stringify(background)}); })()`;
}

/** Mermaid's browser global, as this file needs it. Declared, not asserted: the page defines it. */
declare const mermaid: {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<{ diagramType: string } | false>;
  render(id: string, text: string): Promise<{ svg: string }>;
};

export async function renderChartInPage(
  source: string,
  theme: string,
  background: string
): Promise<InPageRenderResult> {
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'strict',
      // Deterministic ids and no width fitting: the file is the whole chart.
      deterministicIds: true,
      suppressErrorRendering: true,
    });
    const parsed = await mermaid.parse(source);
    if (!parsed) return { ok: false, message: 'The diagram could not be parsed.' };
    const { svg } = await mermaid.render('renkei-chart', source);
    const container = document.getElementById('chart');
    if (!container) return { ok: false, message: 'The page has no chart container.' };
    container.innerHTML = svg;
    const element = container.querySelector('svg');
    if (!element) return { ok: false, message: 'Mermaid produced no SVG.' };
    const viewBox = element.getAttribute('viewBox');
    element.style.maxWidth = '';
    element.style.width = '';
    element.style.height = '';
    element.removeAttribute('width');
    element.removeAttribute('height');
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        element.setAttribute('width', String(Math.ceil(parts[2])));
        element.setAttribute('height', String(Math.ceil(parts[3])));
      }
    }
    if (background !== 'transparent') element.style.backgroundColor = background;
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      diagramType: parsed.diagramType,
      svg: container.innerHTML,
      width: rect.width,
      height: rect.height,
    };
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error);
    return { ok: false, message };
  }
}

/** The page the chart is drawn on: nothing but a padded container on the asked-for background. */
export function chartPageHtml(background: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `html,body{margin:0;padding:0;background:${background === 'transparent' ? 'transparent' : background}}` +
    `#chart{display:inline-block;padding:${CHART_PADDING_PX}px;line-height:0}` +
    '</style></head><body><div id="chart"></div></body></html>'
  );
}

/** The SVG as a standalone file: an XML declaration in front of what Mermaid drew. */
export function standaloneSvg(svg: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`, 'utf8');
}

class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  get inFlight(): number {
    return this.active + this.waiting.length;
  }
}

export class ChartRenderer implements ChartVerbs {
  private readonly launch: LaunchChartBrowser;
  private readonly bundle: string | null;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly gate: Gate;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(deps: ChartRendererDeps = {}) {
    this.launch = deps.launch ?? defaultChartLaunch;
    this.bundle = deps.mermaidBundle ?? resolveMermaidBundle();
    this.idleMs = deps.idleMs ?? CHART_IDLE_MS;
    this.timeoutMs = deps.timeoutMs ?? CHART_RENDER_TIMEOUT_MS;
    this.gate = new Gate(deps.maxConcurrent ?? CHART_MAX_CONCURRENT);
    if (!this.bundle) {
      logger.warn(
        'the Mermaid bundle was not found: every chart will be refused (set SANDBOX_MERMAID_BUNDLE or install mermaid)',
        { component: 'worker-sandbox/charts' }
      );
    }
  }

  /** Where the Mermaid bundle was found, for the boot log; null when nowhere. */
  get mermaidBundle(): string | null {
    return this.bundle;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      try {
        const browser = await this.launch();
        browser.once('disconnected', () => {
          const expected = this.closed || this.browser !== browser;
          if (this.browser === browser) this.browser = null;
          if (!expected) {
            logger.warn('chart browser process disconnected', {
              component: 'worker-sandbox/charts',
            });
          }
        });
        this.browser = browser;
        return browser;
      } catch (error) {
        logger.error('chart browser launch failed: {error}', {
          component: 'worker-sandbox/charts',
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ChartRenderError(
          'charts_unavailable',
          'The chart renderer could not be started on this deployment.'
        );
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.gate.inFlight > 0) {
        this.touchIdle();
        return;
      }
      const browser = this.browser;
      this.browser = null;
      if (browser) {
        void browser.close().catch(() => {
          // Already gone; nothing to release.
        });
      }
    }, this.idleMs);
    this.idleTimer.unref();
  }

  async render(request: ChartRequest): Promise<ChartRendered> {
    if (this.closed) {
      throw new ChartRenderError('charts_unavailable', 'The chart renderer is shutting down.');
    }
    if (!this.bundle) {
      throw new ChartRenderError(
        'charts_unavailable',
        'The chart renderer has no Mermaid bundle on this deployment.'
      );
    }
    await this.gate.acquire();
    try {
      const browser = await this.ensureBrowser();
      return await this.withTimeout(this.renderIn(browser, request));
    } finally {
      this.gate.release();
      this.touchIdle();
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ChartRenderError(
              'timeout',
              `The chart did not render within ${Math.round(this.timeoutMs / 1000)} seconds; simplify it or split it.`
            )
          ),
        this.timeoutMs
      );
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async renderIn(browser: Browser, request: ChartRequest): Promise<ChartRendered> {
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        viewport: { width: 1600, height: 1200 },
        deviceScaleFactor: request.format === 'png' ? request.scale : 1,
        javaScriptEnabled: true,
        offline: true,
      });
      // Belt and braces with `offline`: nothing the page names is fetched.
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(chartPageHtml(request.background), { waitUntil: 'load' });
      await page.addScriptTag({ path: this.bundle ?? undefined });
      const drawn = await page.evaluate<InPageRenderResult>(
        chartScriptSource(request.source, request.theme, request.background)
      );
      if (!drawn.ok || !drawn.svg) {
        throw new ChartRenderError(
          'invalid_diagram',
          `Mermaid could not draw this diagram: ${drawn.message ?? 'unknown error'}`
        );
      }
      const width = Math.ceil((drawn.width ?? 0) + 2 * CHART_PADDING_PX);
      const height = Math.ceil((drawn.height ?? 0) + 2 * CHART_PADDING_PX);
      if (width <= 2 * CHART_PADDING_PX || height <= 2 * CHART_PADDING_PX) {
        throw new ChartRenderError(
          'invalid_diagram',
          'Mermaid drew nothing measurable for this diagram; check that it has content.'
        );
      }
      if (width > CHART_MAX_DIMENSION_PX || height > CHART_MAX_DIMENSION_PX) {
        throw new ChartRenderError(
          'too_large',
          `The chart is ${width}×${height} pixels; each side is at most ${CHART_MAX_DIMENSION_PX}. Split it, or shorten its labels.`
        );
      }
      const diagramType = drawn.diagramType ?? 'unknown';
      const mediaType = chartMediaType(request.format);
      switch (request.format) {
        case 'svg':
          return { bytes: standaloneSvg(drawn.svg), mediaType, width, height, diagramType };
        case 'png': {
          await page.setViewportSize({ width, height });
          const bytes = await page.locator('#chart').screenshot({
            type: 'png',
            omitBackground: request.background === 'transparent',
            animations: 'disabled',
          });
          return { bytes, mediaType, width, height, diagramType };
        }
        case 'pdf': {
          const bytes = await page.pdf({
            width: `${width}px`,
            height: `${height}px`,
            printBackground: true,
            pageRanges: '1',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          });
          return { bytes, mediaType, width, height, diagramType };
        }
        default:
          throw new ChartRenderError('render_failed', `Unknown format ${String(request.format)}.`);
      }
    } catch (error) {
      if (error instanceof ChartRenderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('chart render failed: {error}', {
        component: 'worker-sandbox/charts',
        error: message,
      });
      throw new ChartRenderError('render_failed', `The chart could not be rendered: ${message}`);
    } finally {
      if (context) {
        await context.close().catch(() => {
          // A context whose browser is already gone; nothing to release.
        });
      }
    }
  }

  /** Close the browser; every later render is refused. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => {
        // Already gone.
      });
    }
  }
}
