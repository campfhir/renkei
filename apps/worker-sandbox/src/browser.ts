/**
 * The sandbox browser — one headless Chromium owned by this worker, one
 * isolated browser context per caller, driven only through the named verbs
 * below. This is what backs the sandbox_browser_* tools: an agent can open
 * a page, read what's on it, click, type, and screenshot, without any
 * selector, script, or byte ever crossing the tool boundary.
 *
 * Why it lives HERE and not in the web app: a browser is a large,
 * network-reaching process. The sandbox worker is already the container
 * that holds nothing but an agent's own transient working state, reachable
 * only over the internal network with a bearer key — the same isolation
 * the credential-holding workers get. So the browser gets that container
 * too, and its screenshots land in the same scratch space with the same
 * TTL and quota.
 *
 * Containment, in order of importance:
 *  - Chromium has no direct network: it is launched behind the loopback
 *    egress proxy (browser-proxy.ts), which resolves every host itself and
 *    refuses the localhost family and every private range — sub-resources,
 *    redirects and websockets included, not just the URL a tool was given.
 *    Loopback is explicitly un-bypassed, so `http://127.0.0.1` from inside
 *    a page reaches the proxy and is refused there.
 *  - Top-level navigation is https-only and additionally pre-checked with
 *    `assertPublicHttpsUrl`, so a blocked URL is refused with a clear
 *    message before the browser ever sees it.
 *  - One context per (tenantId, subject): cookies, storage and pages never
 *    cross callers. Contexts are closed after BROWSER_SESSION_IDLE_MS of
 *    disuse and capped at BROWSER_MAX_SESSIONS (least recently used is
 *    evicted); the browser process itself exits once no session remains.
 *  - Every action addresses an element by the ref the last snapshot
 *    stamped on it (`data-renkei-ref`), validated to the `e<digits>` shape
 *    before it goes anywhere near a selector. Downloads are refused,
 *    service workers blocked, and non-http(s) URLs are never navigable.
 *  - Calls on one session are serialized, so two tool calls racing for the
 *    same page cannot interleave a click with a snapshot.
 *
 * Every verb is one `BrowserStep` (@renkei/connector-sandbox) executed by
 * `perform`; `run` executes a whole list of them in one round trip and
 * reports how far it got. The single-verb methods exist so the common
 * case stays one call with one snapshot back.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core';
import {
  assertPublicHttpsUrl,
  BlockedUrlError,
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_MAX_SESSIONS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_SESSION_IDLE_MS,
  BROWSER_SETTLE_TIMEOUT_MS,
  BROWSER_SCROLL_DEFAULT_PX,
  BROWSER_SNAPSHOT_MAX_NODES,
  BROWSER_VIEWPORT,
  BROWSER_WAIT_MAX_MS,
  isBrowserRef,
  parseBrowserStep,
  parseBrowserSteps,
  renderBrowserSnapshot,
  type BrowserPageState,
  type BrowserRunResult,
  type BrowserStep,
} from '@renkei/connector-sandbox';
import { pageScriptSource, REF_ATTRIBUTE, type PageWalkResult } from './browser-page-script';
import { startEgressProxy, type EgressProxy } from './browser-proxy';
import { logger } from './logger';

export type BrowserErrorType =
  | 'browser_unavailable'
  | 'blocked_url'
  | 'no_session'
  | 'bad_ref'
  | 'bad_request'
  | 'navigation_failed'
  | 'action_failed';

export class BrowserOpError extends Error {
  constructor(
    readonly type: BrowserErrorType,
    message: string
  ) {
    super(message);
    this.name = 'BrowserOpError';
  }
}

export interface BrowserTarget {
  tenantId: string;
  subject: string;
}

/** The subset of a launched browser the session manager relies on — the test seam. */
export type LaunchBrowser = (proxyServer: string) => Promise<Browser>;

export interface BrowserSessionsDeps {
  /** Default: playwright-core's chromium, headless, behind the egress proxy. */
  launch?: LaunchBrowser;
  /** Default: the real loopback proxy; tests may hand in a stub. */
  proxy?: () => Promise<EgressProxy>;
  now?: () => number;
  idleMs?: number;
  maxSessions?: number;
  /** How often idle sessions are swept; default one minute. */
  sweepIntervalMs?: number;
}

interface Session {
  key: string;
  target: BrowserTarget;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  /** The tail of this session's serialized work queue. */
  queue: Promise<unknown>;
}

/** How long after a click/submit/key press a popup is still waited for. */
const POPUP_WAIT_MS = 300;
/** A beat after a scroll, for smooth scrolling and lazy content to catch up. */
const SCROLL_SETTLE_MS = 150;

/** Playwright's messages carry a call log; the first line is the part a model can act on. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n')[0]?.trim() ?? '';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line || 'the browser reported an error';
}

function sessionKey(target: BrowserTarget): string {
  return `${target.tenantId}\n${target.subject}`;
}

/** Chromium's own executable resolution, unless the image pins one (SANDBOX_BROWSER_EXECUTABLE). */
export function defaultLaunch(proxyServer: string): Promise<Browser> {
  const executablePath = process.env.SANDBOX_BROWSER_EXECUTABLE?.trim() || undefined;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    // `<-loopback>` removes Chromium's implicit proxy bypass for localhost,
    // so even 127.0.0.1 is sent to the proxy — and refused there.
    proxy: { server: proxyServer, bypass: '<-loopback>' },
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

export class BrowserSessions {
  private readonly launch: LaunchBrowser;
  private readonly startProxy: () => Promise<EgressProxy>;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, Session>();
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private proxy: EgressProxy | null = null;
  private readonly sweep: NodeJS.Timeout;
  private closed = false;

  constructor(deps: BrowserSessionsDeps = {}) {
    this.launch = deps.launch ?? defaultLaunch;
    this.startProxy = deps.proxy ?? (() => startEgressProxy());
    this.now = deps.now ?? (() => Date.now());
    this.idleMs = deps.idleMs ?? BROWSER_SESSION_IDLE_MS;
    this.maxSessions = deps.maxSessions ?? BROWSER_MAX_SESSIONS;
    this.sweep = setInterval(() => void this.sweepIdle(), deps.sweepIntervalMs ?? 60_000);
    this.sweep.unref();
  }

  /** How many callers currently hold an open browser context. */
  sessionCount(): number {
    return this.sessions.size;
  }

  private async browserInstance(): Promise<Browser> {
    if (this.closed)
      throw new BrowserOpError('browser_unavailable', 'The browser is shutting down.');
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      try {
        this.proxy ??= await this.startProxy();
        const browser = await this.launch(`http://127.0.0.1:${this.proxy.port}`);
        browser.once('disconnected', () => {
          // A crash takes every context with it; forget them so the next
          // call relaunches instead of talking to a dead process. Expected
          // (and silent) when this worker closed the browser itself.
          const expected = this.closed || this.browser !== browser;
          if (this.browser === browser) this.browser = null;
          this.sessions.clear();
          if (!expected) {
            logger.warn('browser process disconnected', { component: 'worker-sandbox/browser' });
          }
        });
        this.browser = browser;
        return browser;
      } catch (error) {
        logger.error('browser launch failed: {error}', {
          component: 'worker-sandbox/browser',
          error: error instanceof Error ? error.message : String(error),
        });
        throw new BrowserOpError(
          'browser_unavailable',
          'The sandbox browser could not be started on this deployment.'
        );
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  private async openSession(target: BrowserTarget): Promise<Session> {
    const key = sessionKey(target);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    while (this.sessions.size >= this.maxSessions) {
      let oldest: Session | undefined;
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
      }
      if (!oldest) break;
      await this.closeSession(oldest);
    }

    const browser = await this.browserInstance();
    const context = await browser.newContext({
      viewport: { ...BROWSER_VIEWPORT },
      acceptDownloads: false,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
    });
    context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(BROWSER_NAVIGATION_TIMEOUT_MS);
    const page = await context.newPage();
    const session: Session = {
      key,
      target,
      context,
      page,
      lastUsedAt: this.now(),
      queue: Promise.resolve(),
    };
    // A popup becomes the active page: that is where the flow went.
    context.on('page', (opened) => {
      session.page = opened;
    });
    this.sessions.set(key, session);
    return session;
  }

  private async closeSession(session: Session): Promise<void> {
    this.sessions.delete(session.key);
    try {
      await session.context.close();
    } catch (error) {
      logger.warn('browser context close failed: {error}', {
        component: 'worker-sandbox/browser',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    for (const session of Array.from(this.sessions.values())) {
      if (session.lastUsedAt < cutoff) await this.closeSession(session);
    }
    if (this.sessions.size === 0 && this.browser && !this.launching) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => {});
    }
  }

  /**
   * Run one verb against a caller's session, serialized behind whatever
   * that session is already doing. `create` opens a session when the
   * caller has none; verbs that only make sense on an open page refuse
   * instead.
   */
  private async withSession<T>(
    target: BrowserTarget,
    create: boolean,
    work: (session: Session, page: Page) => Promise<T>
  ): Promise<T> {
    let session = this.sessions.get(sessionKey(target));
    if (!session) {
      if (!create) {
        throw new BrowserOpError(
          'no_session',
          'No page is open — open one with sandbox_browser_navigate first.'
        );
      }
      session = await this.openSession(target);
    }
    const current = session;
    const run = current.queue.then(async () => {
      current.lastUsedAt = this.now();
      const page = await this.activePage(current);
      try {
        return await work(current, page);
      } finally {
        current.lastUsedAt = this.now();
      }
    });
    current.queue = run.catch(() => undefined);
    return run;
  }

  private async activePage(session: Session): Promise<Page> {
    if (!session.page.isClosed()) return session.page;
    const pages = session.context.pages();
    session.page = pages[pages.length - 1] ?? (await session.context.newPage());
    return session.page;
  }

  private async settle(page: Page): Promise<void> {
    await page
      .waitForLoadState('domcontentloaded', { timeout: BROWSER_NAVIGATION_TIMEOUT_MS })
      .catch(() => {});
    await page
      .waitForLoadState('networkidle', { timeout: BROWSER_SETTLE_TIMEOUT_MS })
      .catch(() => {});
  }

  /**
   * Arm a short wait for a popup BEFORE an action that might open one. The
   * context's 'page' listener adopts a popup whenever it arrives; this
   * promise just makes `finish` hold the door for one that is still being
   * created when the action itself returns.
   */
  private popupWindow(session: Session): Promise<Page | null> {
    return session.context.waitForEvent('page', { timeout: POPUP_WAIT_MS }).then(
      (opened) => opened,
      () => null
    );
  }

  /** After a verb: whichever page the flow is on now (a popup may have taken over), settled and read. */
  private async finish(
    session: Session,
    maxChars: number,
    popup?: Promise<Page | null>
  ): Promise<BrowserPageState> {
    const opened = popup ? await popup : null;
    if (opened && !opened.isClosed()) session.page = opened;
    const page = await this.activePage(session);
    await this.settle(page);
    return this.state(page, maxChars);
  }

  private async state(page: Page, maxChars: number): Promise<BrowserPageState> {
    const url = page.url();
    if (url.startsWith('chrome-error://')) {
      // Chromium's own error page: the egress proxy refused the host, or it
      // was unreachable. Nothing on it is worth reading.
      throw new BrowserOpError(
        'navigation_failed',
        'The browser could not load that page — the address was refused (private and internal ' +
          'hosts are blocked) or unreachable.'
      );
    }
    if (!/^https?:/i.test(url) && url !== 'about:blank') {
      // Only http(s) pages are ever readable; anything else is walked away from.
      await page.goto('about:blank').catch(() => {});
      throw new BrowserOpError(
        'navigation_failed',
        'The page moved to a non-web URL and was closed.'
      );
    }
    let walked: PageWalkResult;
    try {
      walked = await page.evaluate<PageWalkResult>(pageScriptSource(BROWSER_SNAPSHOT_MAX_NODES));
    } catch (firstError) {
      // A navigation mid-evaluate tears the execution context down; wait
      // for the new document and walk that one instead.
      await this.settle(page);
      try {
        walked = await page.evaluate<PageWalkResult>(pageScriptSource(BROWSER_SNAPSHOT_MAX_NODES));
      } catch {
        throw new BrowserOpError(
          'action_failed',
          `Could not read the page: ${firstLine(firstError)}`
        );
      }
    }
    const title = await page.title().catch(() => '');
    const rendered = renderBrowserSnapshot(
      { url: page.url(), title },
      walked.nodes,
      maxChars,
      walked.truncated
    );
    return { url: page.url(), title, snapshot: rendered.snapshot, truncated: rendered.truncated };
  }

  private locatorFor(page: Page, ref: unknown): Locator {
    if (!isBrowserRef(ref)) {
      throw new BrowserOpError(
        'bad_ref',
        'A ref looks like e12 — take it from the latest snapshot.'
      );
    }
    return page.locator(`[${REF_ATTRIBUTE}="${ref}"]`).first();
  }

  private async requireRef(page: Page, ref: unknown): Promise<Locator> {
    const locator = this.locatorFor(page, ref);
    if ((await locator.count()) === 0) {
      throw new BrowserOpError(
        'bad_ref',
        `No element carries ref ${String(ref)} on the current page — take a new snapshot.`
      );
    }
    return locator;
  }

  /**
   * Execute one step on the session's active page. The core every public
   * verb and `run` share: it does the action and nothing else — no settle,
   * no snapshot — and reports whether the step may have moved the page
   * (so the caller waits for it to load) and any popup window it armed.
   */
  private async perform(
    session: Session,
    page: Page,
    step: BrowserStep
  ): Promise<{ moves: boolean; popup?: Promise<Page | null> }> {
    switch (step.kind) {
      case 'navigate': {
        const url = await this.publicUrl(step.url);
        try {
          await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        } catch (error) {
          throw new BrowserOpError(
            'navigation_failed',
            `Could not open ${url.hostname}: ${firstLine(error)}`
          );
        }
        return { moves: true };
      }
      case 'click': {
        const locator = await this.requireRef(page, step.ref);
        const popup = this.popupWindow(session);
        try {
          await locator.click();
        } catch (error) {
          throw new BrowserOpError('action_failed', `Click failed: ${firstLine(error)}`);
        }
        return { moves: true, popup };
      }
      case 'type': {
        const locator = await this.requireRef(page, step.ref);
        const popup = step.submit ? this.popupWindow(session) : undefined;
        try {
          await locator.fill(step.text);
          if (step.submit) await locator.press('Enter');
        } catch (error) {
          throw new BrowserOpError('action_failed', `Typing failed: ${firstLine(error)}`);
        }
        return { moves: step.submit === true, popup };
      }
      case 'select': {
        const locator = await this.requireRef(page, step.ref);
        try {
          await locator.selectOption(step.values);
        } catch (error) {
          throw new BrowserOpError('action_failed', `Select failed: ${firstLine(error)}`);
        }
        return { moves: false };
      }
      case 'press': {
        const popup = this.popupWindow(session);
        try {
          await page.keyboard.press(step.key);
        } catch (error) {
          throw new BrowserOpError('action_failed', `Key press failed: ${firstLine(error)}`);
        }
        return { moves: true, popup };
      }
      case 'scroll': {
        try {
          if (step.ref !== undefined) {
            const locator = await this.requireRef(page, step.ref);
            await locator.scrollIntoViewIfNeeded();
          } else {
            const amount = step.amount ?? BROWSER_SCROLL_DEFAULT_PX;
            await page.mouse.wheel(0, step.direction === 'up' ? -amount : amount);
          }
          // Smooth scrolling and lazy-loaded content need a beat before a
          // snapshot reflects the new viewport.
          await page.waitForTimeout(SCROLL_SETTLE_MS);
        } catch (error) {
          if (error instanceof BrowserOpError) throw error;
          throw new BrowserOpError('action_failed', `Scroll failed: ${firstLine(error)}`);
        }
        return { moves: false };
      }
      case 'wait': {
        if (step.ms) await page.waitForTimeout(step.ms);
        if (step.text !== undefined) {
          try {
            await page
              .getByText(step.text)
              .first()
              .waitFor({ state: 'visible', timeout: BROWSER_WAIT_MAX_MS });
          } catch {
            throw new BrowserOpError(
              'action_failed',
              `"${step.text}" did not appear on the page within ${BROWSER_WAIT_MAX_MS / 1000}s.`
            );
          }
        }
        return { moves: false };
      }
      case 'back': {
        try {
          await page.goBack({ waitUntil: 'domcontentloaded' });
        } catch (error) {
          throw new BrowserOpError('navigation_failed', `Could not go back: ${firstLine(error)}`);
        }
        return { moves: true };
      }
    }
  }

  /** The https-only, public-address check every top-level navigation passes first. */
  private async publicUrl(raw: string): Promise<URL> {
    try {
      return await assertPublicHttpsUrl(raw);
    } catch (error) {
      if (error instanceof BlockedUrlError) throw new BrowserOpError('blocked_url', error.message);
      throw new BrowserOpError('bad_request', 'That URL is not usable.');
    }
  }

  /** One validated step, then the page it left behind. */
  private single(
    target: BrowserTarget,
    raw: unknown,
    maxChars: number,
    create = false
  ): Promise<BrowserPageState> {
    const parsed = parseBrowserStep(raw);
    if (!parsed.ok) throw new BrowserOpError(parsed.type, parsed.message);
    const step = parsed.step;
    return this.withSession(target, create, async (session, page) => {
      const outcome = await this.perform(session, page, step);
      return this.finish(session, maxChars, outcome.popup);
    });
  }

  async navigate(
    target: BrowserTarget,
    rawUrl: string,
    maxChars: number
  ): Promise<BrowserPageState> {
    // Checked before a session is opened, so a blocked URL never costs a
    // browser launch or an empty context.
    await this.publicUrl(rawUrl);
    return this.single(target, { kind: 'navigate', url: rawUrl }, maxChars, true);
  }

  async snapshot(target: BrowserTarget, maxChars: number): Promise<BrowserPageState> {
    return this.withSession(target, false, (_session, page) => this.state(page, maxChars));
  }

  async click(target: BrowserTarget, ref: unknown, maxChars: number): Promise<BrowserPageState> {
    return this.single(target, { kind: 'click', ref }, maxChars);
  }

  async type(
    target: BrowserTarget,
    ref: unknown,
    text: unknown,
    submit: boolean,
    maxChars: number
  ): Promise<BrowserPageState> {
    return this.single(target, { kind: 'type', ref, text, submit }, maxChars);
  }

  async select(
    target: BrowserTarget,
    ref: unknown,
    values: unknown,
    maxChars: number
  ): Promise<BrowserPageState> {
    return this.single(target, { kind: 'select', ref, values }, maxChars);
  }

  async press(target: BrowserTarget, key: unknown, maxChars: number): Promise<BrowserPageState> {
    return this.single(target, { kind: 'press', key }, maxChars);
  }

  /** Scroll the page (or bring one ref into view); `input` is the scroll step's fields. */
  async scroll(target: BrowserTarget, input: unknown, maxChars: number): Promise<BrowserPageState> {
    const fields = typeof input === 'object' && input !== null ? input : {};
    return this.single(target, { ...fields, kind: 'scroll' }, maxChars);
  }

  async back(target: BrowserTarget, maxChars: number): Promise<BrowserPageState> {
    return this.single(target, { kind: 'back' }, maxChars);
  }

  /**
   * Several steps in one round trip, stopping at the first that fails.
   * Every step waits for the page to load when it may have moved it, so a
   * type-then-submit-then-wait-for-text sequence behaves as it reads. The
   * answer carries how far it got and the page it ended on, so a partial
   * run is still something the model can continue from.
   */
  async run(target: BrowserTarget, rawSteps: unknown, maxChars: number): Promise<BrowserRunResult> {
    const parsed = parseBrowserSteps(rawSteps);
    if (!parsed.ok) throw new BrowserOpError(parsed.type, parsed.message);
    const steps = parsed.steps;
    const first = steps[0];
    // Only a navigate may open a session; and its URL is checked before
    // the launch, as the single verb does.
    const create = first.kind === 'navigate';
    if (create) await this.publicUrl(first.url);
    return this.withSession(target, create, async (session) => {
      let completed = 0;
      let failed: BrowserRunResult['failed'] = null;
      for (const [index, step] of steps.entries()) {
        const page = await this.activePage(session);
        try {
          const outcome = await this.perform(session, page, step);
          const opened = outcome.popup ? await outcome.popup : null;
          if (opened && !opened.isClosed()) session.page = opened;
          if (outcome.moves || opened) await this.settle(await this.activePage(session));
          completed += 1;
        } catch (error) {
          const known =
            error instanceof BrowserOpError
              ? error
              : new BrowserOpError('action_failed', firstLine(error));
          failed = { index, kind: step.kind, type: known.type, message: known.message };
          break;
        }
      }
      let page: BrowserPageState | null = null;
      try {
        page = await this.state(await this.activePage(session), maxChars);
      } catch (error) {
        // The page after a failed navigation may be unreadable; the failure
        // already says why, so the run answers without a snapshot rather
        // than hiding how far it got.
        if (!failed) throw error;
      }
      return { completed, page, failed };
    });
  }

  /** A PNG of the current page; the server stages it as a scratch-space file. */
  async screenshot(
    target: BrowserTarget,
    fullPage: boolean
  ): Promise<{ bytes: Buffer; url: string; title: string }> {
    return this.withSession(target, false, async (_session, page) => {
      let bytes: Buffer;
      try {
        bytes = await page.screenshot({ type: 'png', fullPage });
      } catch (error) {
        throw new BrowserOpError('action_failed', `Screenshot failed: ${firstLine(error)}`);
      }
      return { bytes, url: page.url(), title: await page.title().catch(() => '') };
    });
  }

  /** Close a caller's session; true when there was one. */
  async close(target: BrowserTarget): Promise<boolean> {
    const session = this.sessions.get(sessionKey(target));
    if (!session) return false;
    await session.queue;
    await this.closeSession(session);
    return true;
  }

  /** Close everything — every context, the browser, the proxy. */
  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweep);
    for (const session of Array.from(this.sessions.values())) await this.closeSession(session);
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
    if (this.proxy) await this.proxy.close();
    this.proxy = null;
  }
}
