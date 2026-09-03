/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The session manager's own contract, against a scripted stand-in for
 * Playwright (no Chromium here — the real browser is exercised by hand,
 * see the module comment in browser.ts): one context per caller and never
 * shared, verbs on a caller with no page refuse, a blocked URL is refused
 * before any launch, refs are validated before they become selectors,
 * idle sessions are swept and the browser released, the session cap
 * evicts the least recently used, and a popup opened by a click becomes
 * the page the next snapshot reads.
 */

import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright-core';
import { BrowserOpError, BrowserSessions } from './browser';

interface FakeLocator {
  count: jest.Mock;
  click: jest.Mock;
  fill: jest.Mock;
  press: jest.Mock;
  selectOption: jest.Mock;
  scrollIntoViewIfNeeded: jest.Mock;
  waitFor: jest.Mock;
  evaluate: jest.Mock;
}

interface FakePage {
  currentUrl: string;
  closed: boolean;
  walk: { nodes: unknown[]; truncated: boolean };
  locators: Map<string, FakeLocator>;
  goto: jest.Mock;
  goBack: jest.Mock;
  url: () => string;
  title: () => Promise<string>;
  isClosed: () => boolean;
  waitForLoadState: jest.Mock;
  evaluate: jest.Mock;
  on: jest.Mock;
  /** Calls to evaluate that walked the page (not the DOM-quiet probe). */
  walks: () => number;
  locator: (selector: string) => { first: () => FakeLocator };
  keyboard: { press: jest.Mock };
  mouse: { wheel: jest.Mock };
  waitForTimeout: jest.Mock;
  /** Text → locator returned by getByText; unknown text answers a locator whose waitFor rejects. */
  texts: Map<string, FakeLocator>;
  getByText: (text: string) => { first: () => FakeLocator };
  screenshot: jest.Mock;
}

interface FakeContext extends EventEmitter {
  pages: () => FakePage[];
  openPages: FakePage[];
  newPage: jest.Mock;
  close: jest.Mock;
  setDefaultTimeout: jest.Mock;
  setDefaultNavigationTimeout: jest.Mock;
  waitForEvent: (name: string, options: { timeout: number }) => Promise<FakePage>;
  closed: boolean;
}

interface FakeBrowser extends EventEmitter {
  contexts: FakeContext[];
  connected: boolean;
  newContext: jest.Mock;
  close: jest.Mock;
  isConnected: () => boolean;
}

function fakeLocator(count = 1): FakeLocator {
  return {
    count: jest.fn(async () => count),
    click: jest.fn(async () => undefined),
    fill: jest.fn(async () => undefined),
    press: jest.fn(async () => undefined),
    selectOption: jest.fn(async () => undefined),
    scrollIntoViewIfNeeded: jest.fn(async () => undefined),
    waitFor: jest.fn(async () => {
      if (count === 0) throw new Error('locator.waitFor: Timeout 10000ms exceeded.');
    }),
    evaluate: jest.fn(async () => undefined),
  };
}

/**
 * Set by a test to shape pages the manager creates on its own (a reopen
 * after a lost session launches a fresh browser and page before the test
 * can reach them); consumed by every fakePage() call while set.
 */
let onPageCreated: ((page: FakePage) => void) | null = null;

function fakePage(url = 'about:blank'): FakePage {
  const page: FakePage = {
    currentUrl: url,
    closed: false,
    // Enough nodes that the "thin page, wait and re-walk" heuristic stays out of the way.
    walk: {
      nodes: [
        { role: 'heading', level: 1, name: 'Fake' },
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'text' as const, name: `filler ${i}` })),
      ],
      truncated: false,
    },
    locators: new Map(),
    goto: jest.fn(async (target: string) => {
      page.currentUrl = target;
    }),
    goBack: jest.fn(async () => {
      page.currentUrl = 'https://example.com/previous';
    }),
    url: () => page.currentUrl,
    title: async () => 'Fake title',
    isClosed: () => page.closed,
    waitForLoadState: jest.fn(async () => undefined),
    // The DOM-quiet probe asks for an element count; anything else is a walk.
    evaluate: jest.fn(async (source: string) =>
      String(source).includes('getElementsByTagName') ? 10 : page.walk
    ),
    on: jest.fn(),
    walks: () =>
      page.evaluate.mock.calls.filter(
        ([source]) => !String(source).includes('getElementsByTagName')
      ).length,
    locator: (selector: string) => {
      const existing = page.locators.get(selector);
      const locator = existing ?? fakeLocator(0);
      if (!existing) page.locators.set(selector, locator);
      return { first: () => locator };
    },
    keyboard: { press: jest.fn(async () => undefined) },
    mouse: { wheel: jest.fn(async () => undefined) },
    waitForTimeout: jest.fn(async () => undefined),
    texts: new Map(),
    getByText: (text: string) => {
      const existing = page.texts.get(text);
      return { first: () => existing ?? fakeLocator(0) };
    },
    screenshot: jest.fn(async () => Buffer.from('PNG-bytes')),
  };
  onPageCreated?.(page);
  return page;
}

function fakeContext(): FakeContext {
  const emitter = new EventEmitter() as FakeContext;
  emitter.openPages = [];
  emitter.closed = false;
  emitter.pages = () => emitter.openPages;
  emitter.newPage = jest.fn(async () => {
    const page = fakePage();
    emitter.openPages.push(page);
    return page;
  });
  emitter.close = jest.fn(async () => {
    emitter.closed = true;
  });
  emitter.setDefaultTimeout = jest.fn();
  emitter.setDefaultNavigationTimeout = jest.fn();
  emitter.waitForEvent = (name, options) =>
    new Promise<FakePage>((resolve, reject) => {
      const timer = setTimeout(() => {
        emitter.off(name, onEvent);
        reject(new Error('Timeout'));
      }, options.timeout);
      const onEvent = (page: FakePage) => {
        clearTimeout(timer);
        resolve(page);
      };
      emitter.once(name, onEvent);
    });
  return emitter;
}

function fakeBrowser(): FakeBrowser {
  const browser = new EventEmitter() as FakeBrowser;
  browser.contexts = [];
  browser.connected = true;
  browser.isConnected = () => browser.connected;
  browser.newContext = jest.fn(async () => {
    const context = fakeContext();
    browser.contexts.push(context);
    return context;
  });
  browser.close = jest.fn(async () => {
    browser.connected = false;
    browser.emit('disconnected');
  });
  return browser;
}

const ALICE = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const BOB = { tenantId: 'tenant-1', subject: 'auth0|bob' };
const stubProxy = async () => ({ port: 1, close: async () => undefined });

function build(overrides: Partial<ConstructorParameters<typeof BrowserSessions>[0]> = {}) {
  const browsers: FakeBrowser[] = [];
  const launch = jest.fn(async () => {
    const browser = fakeBrowser();
    browsers.push(browser);
    return browser as unknown as Browser;
  });
  const clock = { now: 1_000_000 };
  const sessions = new BrowserSessions({
    launch,
    proxy: stubProxy,
    now: () => clock.now,
    sweepIntervalMs: 60 * 60_000,
    ...overrides,
  });
  return { sessions, launch, browsers, clock };
}

async function expectBrowserError(
  promise: Promise<unknown>,
  type: string
): Promise<BrowserOpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserOpError);
    expect((error as BrowserOpError).type).toBe(type);
    return error as BrowserOpError;
  }
  throw new Error(`expected a ${type} error`);
}

describe('sessions and isolation', () => {
  it('opens one context per caller, reuses it, and never shares it', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/a', 5000);
    await sessions.navigate(ALICE, 'https://example.com/b', 5000);
    await sessions.navigate(BOB, 'https://example.com/c', 5000);
    expect(browsers).toHaveLength(1);
    expect(browsers[0].contexts).toHaveLength(2);
    expect(sessions.sessionCount()).toBe(2);
    const alicePage = browsers[0].contexts[0].openPages[0];
    expect(alicePage.goto).toHaveBeenCalledTimes(2);
    expect(alicePage.currentUrl).toBe('https://example.com/b');
    expect(browsers[0].contexts[1].openPages[0].currentUrl).toBe('https://example.com/c');
    await sessions.shutdown();
  });

  it('answers every page verb with the rendered state of the page', async () => {
    const { sessions } = build();
    const state = await sessions.navigate(ALICE, 'https://example.com/', 5000);
    expect(state.url).toBe('https://example.com/');
    expect(state.title).toBe('Fake title');
    expect(
      state.snapshot.startsWith('Page: Fake title\nURL: https://example.com/\n---\n# Fake')
    ).toBe(true);
    expect(state.truncated).toBe(false);
    await sessions.shutdown();
  });

  it('refuses page verbs for a caller with no open page, without launching', async () => {
    const { sessions, launch } = build();
    await expectBrowserError(sessions.snapshot(ALICE, 5000), 'no_session');
    await expectBrowserError(sessions.click(ALICE, 'e1', 5000), 'no_session');
    await expectBrowserError(sessions.screenshot(ALICE, false), 'no_session');
    expect(launch).not.toHaveBeenCalled();
    expect(await sessions.close(ALICE)).toBe(false);
    await sessions.shutdown();
  });

  it('closes a caller session on request and reports it', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    expect(await sessions.close(ALICE)).toBe(true);
    expect(browsers[0].contexts[0].close).toHaveBeenCalled();
    expect(sessions.sessionCount()).toBe(0);
    await expectBrowserError(sessions.snapshot(ALICE, 5000), 'no_session');
    await sessions.shutdown();
  });
});

describe('egress and launch', () => {
  it('refuses a blocked or non-https URL before the browser is ever launched', async () => {
    const { sessions, launch } = build();
    await expectBrowserError(
      sessions.navigate(ALICE, 'https://169.254.169.254/x', 5000),
      'blocked_url'
    );
    await expectBrowserError(sessions.navigate(ALICE, 'http://example.com/', 5000), 'blocked_url');
    await expectBrowserError(sessions.navigate(ALICE, 'not a url', 5000), 'blocked_url');
    expect(launch).not.toHaveBeenCalled();
    await sessions.shutdown();
  });

  it('turns a failed launch into browser_unavailable and retries on the next call', async () => {
    const launch = jest
      .fn<Promise<Browser>, [string]>()
      .mockRejectedValueOnce(new Error('no chromium'))
      .mockImplementation(async () => fakeBrowser() as unknown as Browser);
    const { sessions } = build({ launch });
    await expectBrowserError(
      sessions.navigate(ALICE, 'https://example.com/', 5000),
      'browser_unavailable'
    );
    await expect(sessions.navigate(ALICE, 'https://example.com/', 5000)).resolves.toBeTruthy();
    expect(launch).toHaveBeenCalledTimes(2);
    await sessions.shutdown();
  });

  it('hands the launcher the proxy address', async () => {
    const { sessions, launch } = build({
      proxy: async () => ({ port: 4321, close: async () => undefined }),
    });
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    expect(launch).toHaveBeenCalledWith('http://127.0.0.1:4321');
    await sessions.shutdown();
  });

  it('reports a navigation the browser could not complete', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    page.goto.mockRejectedValueOnce(
      new Error('net::ERR_TUNNEL_CONNECTION_FAILED\nCall log:\n  - x')
    );
    const error = await expectBrowserError(
      sessions.navigate(ALICE, 'https://example.com/y', 5000),
      'navigation_failed'
    );
    expect(error.message).toBe('Could not open example.com: net::ERR_TUNNEL_CONNECTION_FAILED');
    await sessions.shutdown();
  });

  it("treats Chromium's own error page as a refused navigation", async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    page.currentUrl = 'chrome-error://chromewebdata/';
    const error = await expectBrowserError(sessions.snapshot(ALICE, 5000), 'navigation_failed');
    expect(error.message).toContain('private and internal hosts are blocked');
    await sessions.shutdown();
  });
});

describe('refs and actions', () => {
  it('validates the ref shape before it becomes a selector', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    for (const bad of ['', 'e', 'E1', 'e1"],*,[x="', '#login', 12]) {
      await expectBrowserError(sessions.click(ALICE, bad, 5000), 'bad_ref');
    }
    expect(page.locators.size).toBe(0);
    await sessions.shutdown();
  });

  it('refuses a ref no element carries, telling the model to re-snapshot', async () => {
    const { sessions } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const error = await expectBrowserError(sessions.click(ALICE, 'e7', 5000), 'bad_ref');
    expect(error.message).toContain('take a new snapshot');
    await sessions.shutdown();
  });

  it('clicks, types, selects and presses by ref, then reads the page again', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const locator = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e3"]', locator);

    await sessions.click(ALICE, 'e3', 5000);
    expect(locator.click).toHaveBeenCalledTimes(1);

    await sessions.type(ALICE, 'e3', 'hello', true, 5000);
    expect(locator.fill).toHaveBeenCalledWith('hello');
    expect(locator.press).toHaveBeenCalledWith('Enter');

    await sessions.select(ALICE, 'e3', ['Blue'], 5000);
    expect(locator.selectOption).toHaveBeenCalledWith(['Blue']);

    await sessions.press(ALICE, 'PageDown', 5000);
    expect(page.keyboard.press).toHaveBeenCalledWith('PageDown');

    const back = await sessions.back(ALICE, 5000);
    expect(page.goBack).toHaveBeenCalled();
    expect(back.url).toBe('https://example.com/previous');
    // Every verb re-walks the page it ends on.
    expect(page.walks()).toBe(6);
    await sessions.shutdown();
  });

  it('bounds typed text, select values, and key names', async () => {
    const { sessions } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    await expectBrowserError(
      sessions.type(ALICE, 'e1', 'x'.repeat(10_001), false, 5000),
      'bad_request'
    );
    await expectBrowserError(sessions.type(ALICE, 'e1', 42, false, 5000), 'bad_request');
    await expectBrowserError(sessions.select(ALICE, 'e1', [], 5000), 'bad_request');
    await expectBrowserError(sessions.select(ALICE, 'e1', 'Blue', 5000), 'bad_request');
    await expectBrowserError(sessions.press(ALICE, 'Enter; rm -rf', 5000), 'bad_request');
    await expectBrowserError(sessions.press(ALICE, 'a'.repeat(41), 5000), 'bad_request');
    await sessions.shutdown();
  });

  it('turns a failed action into action_failed with the first line of the cause', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const locator = fakeLocator(1);
    locator.click.mockRejectedValueOnce(
      new Error('locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting')
    );
    page.locators.set('[data-renkei-ref="e1"]', locator);
    const error = await expectBrowserError(sessions.click(ALICE, 'e1', 5000), 'action_failed');
    expect(error.message).toBe('Click failed: locator.click: Timeout 10000ms exceeded.');
    await sessions.shutdown();
  });

  it('adopts a popup a click opens as the page the next snapshot reads', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const context = browsers[0].contexts[0];
    const page = context.openPages[0];
    const locator = fakeLocator(1);
    locator.click.mockImplementation(async () => {
      const popup = fakePage('https://example.com/popup');
      context.openPages.push(popup);
      setTimeout(() => context.emit('page', popup), 20);
    });
    page.locators.set('[data-renkei-ref="e2"]', locator);
    const after = await sessions.click(ALICE, 'e2', 5000);
    expect(after.url).toBe('https://example.com/popup');
    const again = await sessions.snapshot(ALICE, 5000);
    expect(again.url).toBe('https://example.com/popup');
    await sessions.shutdown();
  });

  it('falls back to another open page when the active one closes', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const context = browsers[0].contexts[0];
    const first = context.openPages[0];
    const second = fakePage('https://example.com/second');
    context.openPages.push(second);
    first.closed = true;
    const state = await sessions.snapshot(ALICE, 5000);
    expect(state.url).toBe('https://example.com/second');
    await sessions.shutdown();
  });

  it('serializes verbs on one session so they never interleave', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const order: string[] = [];
    const locator = fakeLocator(1);
    locator.click.mockImplementation(async () => {
      order.push('click-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('click-end');
    });
    page.locators.set('[data-renkei-ref="e1"]', locator);
    page.evaluate.mockImplementation(async (source: string) => {
      if (String(source).includes('getElementsByTagName')) return 10;
      order.push('walk');
      return page.walk;
    });
    await Promise.all([sessions.click(ALICE, 'e1', 5000), sessions.snapshot(ALICE, 5000)]);
    expect(order).toEqual(['click-start', 'click-end', 'walk', 'walk']);
    await sessions.shutdown();
  });

  it('returns screenshot bytes with where the page is', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/shot', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const shot = await sessions.screenshot(ALICE, true);
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
    expect(shot.bytes.toString()).toBe('PNG-bytes');
    expect(shot.url).toBe('https://example.com/shot');
    await sessions.shutdown();
  });

  it('bounds the snapshot text and says so', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    page.walk = {
      nodes: Array.from({ length: 50 }, (_, i) => ({
        role: 'text',
        name: `line ${i} ${'x'.repeat(40)}`,
      })),
      truncated: true,
    };
    const state = await sessions.snapshot(ALICE, 300);
    expect(state.truncated).toBe(true);
    expect(state.snapshot.length).toBeLessThan(400);
    expect(state.snapshot).toContain('[snapshot truncated');
    await sessions.shutdown();
  });
});

describe('scroll and wait', () => {
  it('scrolls the page by wheel, or one ref into view', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    await sessions.scroll(ALICE, {}, 5000);
    expect(page.mouse.wheel).toHaveBeenLastCalledWith(0, 720);
    await sessions.scroll(ALICE, { direction: 'up', amount: 300 }, 5000);
    expect(page.mouse.wheel).toHaveBeenLastCalledWith(0, -300);
    const locator = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e4"]', locator);
    await sessions.scroll(ALICE, { ref: 'e4' }, 5000);
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(page.mouse.wheel).toHaveBeenCalledTimes(2);
    await expectBrowserError(sessions.scroll(ALICE, { amount: -1 }, 5000), 'bad_request');
    await expectBrowserError(sessions.scroll(ALICE, { ref: 'nope' }, 5000), 'bad_ref');
    await sessions.shutdown();
  });
});

describe('run', () => {
  it('executes steps in order on one page and answers the final state', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/form', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const order: string[] = [];
    const name = fakeLocator(1);
    name.fill.mockImplementation(async (text: string) => {
      order.push(`fill:${text}`);
    });
    const color = fakeLocator(1);
    color.selectOption.mockImplementation(async (values: string[]) => {
      order.push(`select:${values.join(',')}`);
    });
    const submit = fakeLocator(1);
    submit.click.mockImplementation(async () => {
      order.push('click');
      page.currentUrl = 'https://example.com/done';
    });
    const saved = fakeLocator(1);
    saved.waitFor.mockImplementation(async () => {
      order.push('wait:Saved');
    });
    page.locators.set('[data-renkei-ref="e1"]', name);
    page.locators.set('[data-renkei-ref="e2"]', color);
    page.locators.set('[data-renkei-ref="e3"]', submit);
    page.texts.set('Saved', saved);
    page.mouse.wheel.mockImplementation(async () => {
      order.push('scroll');
    });

    const result = await sessions.run(
      ALICE,
      [
        { kind: 'type', ref: 'e1', text: 'Renkei' },
        { kind: 'select', ref: 'e2', values: ['Blue'] },
        { kind: 'scroll' },
        { kind: 'click', ref: 'e3' },
        { kind: 'wait', ms: 200, text: 'Saved' },
      ],
      5000
    );

    expect(order).toEqual(['fill:Renkei', 'select:Blue', 'scroll', 'click', 'wait:Saved']);
    expect(page.waitForTimeout).toHaveBeenCalledWith(200);
    expect(result.failed).toBeNull();
    expect(result.completed).toBe(5);
    expect(result.page?.url).toBe('https://example.com/done');
    // One snapshot at the end, not one per step.
    expect(page.walks()).toBe(2);
    await sessions.shutdown();
  });

  it('stops at the first failing step and says which, keeping the page it is on', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/form', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const field = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e1"]', field);
    const later = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e3"]', later);

    const result = await sessions.run(
      ALICE,
      [
        { kind: 'type', ref: 'e1', text: 'a' },
        { kind: 'click', ref: 'e2' }, // no such element
        { kind: 'click', ref: 'e3' },
      ],
      5000
    );

    expect(result.completed).toBe(1);
    expect(result.failed).toMatchObject({ index: 1, kind: 'click', type: 'bad_ref' });
    expect(result.failed?.message).toContain('take a new snapshot');
    expect(later.click).not.toHaveBeenCalled();
    expect(result.page?.url).toBe('https://example.com/form');
    await sessions.shutdown();
  });

  it('reports a wait-for-text that never appears', async () => {
    const { sessions } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const result = await sessions.run(ALICE, [{ kind: 'wait', text: 'Never' }], 5000);
    expect(result.completed).toBe(0);
    expect(result.failed).toMatchObject({ index: 0, kind: 'wait', type: 'action_failed' });
    expect(result.failed?.message).toContain('"Never" did not appear');
    await sessions.shutdown();
  });

  it('refuses a malformed list before anything runs', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    await expectBrowserError(sessions.run(ALICE, [], 5000), 'bad_request');
    await expectBrowserError(sessions.run(ALICE, [{ kind: 'evaluate' }], 5000), 'bad_request');
    await expectBrowserError(sessions.run(ALICE, [{ kind: 'click', ref: 'x' }], 5000), 'bad_ref');
    expect(page.locators.size).toBe(0);
    await sessions.shutdown();
  });

  it('opens a session only when the first step is a navigate', async () => {
    const { sessions, launch } = build();
    await expectBrowserError(
      sessions.run(ALICE, [{ kind: 'click', ref: 'e1' }], 5000),
      'no_session'
    );
    await expectBrowserError(
      sessions.run(ALICE, [{ kind: 'navigate', url: 'https://10.0.0.1/' }], 5000),
      'blocked_url'
    );
    expect(launch).not.toHaveBeenCalled();
    const result = await sessions.run(
      ALICE,
      [
        { kind: 'navigate', url: 'https://example.com/a' },
        { kind: 'press', key: 'PageDown' },
      ],
      5000
    );
    expect(result.completed).toBe(2);
    expect(result.page?.url).toBe('https://example.com/a');
    expect(sessions.sessionCount()).toBe(1);
    await sessions.shutdown();
  });

  it('adopts a popup a step opens and continues on it', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const context = browsers[0].contexts[0];
    const page = context.openPages[0];
    const opener = fakeLocator(1);
    const popup = fakePage('https://example.com/popup');
    opener.click.mockImplementation(async () => {
      context.openPages.push(popup);
      setTimeout(() => context.emit('page', popup), 20);
    });
    page.locators.set('[data-renkei-ref="e1"]', opener);
    const result = await sessions.run(
      ALICE,
      [
        { kind: 'click', ref: 'e1' },
        { kind: 'press', key: 'End' },
      ],
      5000
    );
    expect(result.completed).toBe(2);
    expect(popup.keyboard.press).toHaveBeenCalledWith('End');
    expect(result.page?.url).toBe('https://example.com/popup');
    await sessions.shutdown();
  });
});

describe('re-rendering pages', () => {
  it('recovers a ref whose element was re-created, by its signature and ordinal', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    // The snapshot the model received: two "Apply" buttons and a search box.
    page.walk = {
      nodes: [
        { role: 'textbox', ref: 'e1', name: 'Search jobs' },
        { role: 'button', ref: 'e2', name: 'Apply' },
        { role: 'button', ref: 'e3', name: 'Apply' },
        { role: 'text', name: 'a' },
        { role: 'text', name: 'b' },
        { role: 'text', name: 'c' },
        { role: 'text', name: 'd' },
        { role: 'text', name: 'e' },
      ],
      truncated: false,
    };
    await sessions.snapshot(ALICE, 5000);
    // The framework re-rendered: attributes gone, a cookie banner inserted
    // ahead, so document order shifted by one.
    page.walk = {
      nodes: [
        { role: 'button', ref: 'e1', name: 'Accept cookies' },
        { role: 'textbox', ref: 'e2', name: 'Search jobs' },
        { role: 'button', ref: 'e3', name: 'Apply' },
        { role: 'button', ref: 'e4', name: 'Apply' },
        { role: 'text', name: 'a' },
        { role: 'text', name: 'b' },
        { role: 'text', name: 'c' },
        { role: 'text', name: 'd' },
      ],
      truncated: false,
    };
    const probed = fakeLocator(1);
    page.locators.set('[data-renkei-probe="e4"]', probed);
    const restamped = fakeLocator(1);
    probed.evaluate.mockImplementation(async () => {
      // The recovery re-stamps the model's ref on the found element.
      page.locators.set('[data-renkei-ref="e3"]', restamped);
    });
    await sessions.click(ALICE, 'e3', 5000);
    expect(probed.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      probe: 'data-renkei-probe',
      ref: 'data-renkei-ref',
      value: 'e3',
    });
    expect(restamped.click).toHaveBeenCalled();
    // The recovery walk used the probe attribute, never the real one.
    const recoveryWalk = page.evaluate.mock.calls.find(([source]) =>
      String(source).includes('"data-renkei-probe"')
    );
    expect(recoveryWalk).toBeDefined();
    await sessions.shutdown();
  });

  it('still refuses a ref whose element is genuinely gone', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    page.walk = { nodes: [{ role: 'button', ref: 'e1', name: 'Apply' }], truncated: false };
    await sessions.snapshot(ALICE, 5000);
    page.walk = {
      nodes: [{ role: 'button', ref: 'e1', name: 'Something else' }],
      truncated: false,
    };
    await expectBrowserError(sessions.click(ALICE, 'e1', 5000), 'bad_ref');
    await sessions.shutdown();
  });

  it('follows a link meant for a new tab in the same tab', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const link = fakeLocator(1);
    link.evaluate.mockResolvedValue('https://careers.example.com/jobs');
    page.locators.set('[data-renkei-ref="e5"]', link);
    const state = await sessions.click(ALICE, 'e5', 5000);
    expect(link.click).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenLastCalledWith('https://careers.example.com/jobs', {
      waitUntil: 'domcontentloaded',
    });
    expect(state.url).toBe('https://careers.example.com/jobs');
    await sessions.shutdown();
  });

  it('reports a crashed page instead of reading it', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const onCrash = page.on.mock.calls.find(([event]) => event === 'crash')?.[1] as () => void;
    expect(onCrash).toBeDefined();
    onCrash();
    const error = await expectBrowserError(sessions.snapshot(ALICE, 5000), 'navigation_failed');
    expect(error.message).toContain('crashed');
    expect(page.goto).toHaveBeenLastCalledWith('about:blank');
    // Recovered: the next read works again.
    await expect(sessions.snapshot(ALICE, 5000)).resolves.toBeTruthy();
    await sessions.shutdown();
  });

  it('waits for the DOM to stop changing before reading, and re-walks a thin page once', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const counts = [10, 20, 30, 30, 30, 30];
    const walks = [
      { nodes: [{ role: 'text', name: 'loading' }], truncated: false },
      {
        nodes: Array.from({ length: 12 }, (_, i) => ({ role: 'text', name: `row ${i}` })),
        truncated: false,
      },
    ];
    page.evaluate.mockImplementation(async (source: string) =>
      String(source).includes('getElementsByTagName')
        ? (counts.shift() ?? 30)
        : (walks.shift() ?? walks[0])
    );
    const state = await sessions.navigate(ALICE, 'https://example.com/list', 5000);
    expect(counts).toEqual([]);
    expect(state.snapshot).toContain('row 11');
    expect(page.waitForTimeout).toHaveBeenCalledWith(1500);
    await sessions.shutdown();
  });
});

describe('secrets', () => {
  it('types a secret resolved for the current host, marks the control, and scrubs the value from what the model reads', async () => {
    const secrets = jest.fn(async () => 'hunter2!');
    const { sessions, browsers } = build({ secrets });
    await sessions.navigate(ALICE, 'https://portal.vendor.com/login', 5000);
    const page = browsers[0].contexts[0].openPages[0];
    const field = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e2"]', field);
    page.walk = {
      nodes: [
        { role: 'text', name: 'Welcome back, hunter2! is not your name' },
        { role: 'textbox', ref: 'e2', name: 'Password', value: '••••••' },
      ],
      truncated: false,
    };
    page.goto.mockImplementation(async () => {
      page.currentUrl = 'https://portal.vendor.com/?q=hunter2%21';
    });

    const state = await sessions.type(ALICE, 'e2', undefined, true, 5000, {
      name: 'vendor-portal',
      field: 'password',
    });
    expect(secrets).toHaveBeenCalledWith(
      ALICE,
      { name: 'vendor-portal', field: 'password' },
      'portal.vendor.com'
    );
    expect(field.fill).toHaveBeenCalledWith('hunter2!');
    expect(field.evaluate).toHaveBeenCalledWith(expect.any(Function), 'data-renkei-secret');
    expect(field.press).toHaveBeenCalledWith('Enter');
    expect(state.snapshot).not.toContain('hunter2');
    expect(state.snapshot).toContain('Welcome back, •••••• is not your name');

    // The value stays scrubbed for the rest of the session, URL included.
    const later = await sessions.navigate(ALICE, 'https://portal.vendor.com/', 5000);
    expect(later.url).toBe('https://portal.vendor.com/?q=••••••');
    await sessions.shutdown();
  });

  it('refuses a secret step when the deployment has no secrets, or the resolver refuses', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://portal.vendor.com/', 5000);
    browsers[0].contexts[0].openPages[0].locators.set('[data-renkei-ref="e1"]', fakeLocator(1));
    const error = await expectBrowserError(
      sessions.type(ALICE, 'e1', undefined, false, 5000, {
        name: 'vendor-portal',
        field: 'password',
      }),
      'secret_unavailable'
    );
    expect(error.message).toContain('not available on this deployment');

    const refusing = build({
      secrets: async () => {
        throw new BrowserOpError('secret_unavailable', 'Secret "vendor-portal" is locked');
      },
    });
    await refusing.sessions.navigate(ALICE, 'https://portal.vendor.com/', 5000);
    const page = refusing.browsers[0].contexts[0].openPages[0];
    const field = fakeLocator(1);
    page.locators.set('[data-renkei-ref="e1"]', field);
    const run = await refusing.sessions.run(
      ALICE,
      [{ kind: 'type', ref: 'e1', secret: { name: 'vendor-portal', field: 'password' } }],
      5000
    );
    expect(run.failed).toMatchObject({ index: 0, type: 'secret_unavailable' });
    expect(field.fill).not.toHaveBeenCalled();
    await sessions.shutdown();
    await refusing.sessions.shutdown();
  });

  it('rejects a type step that gives both text and a secret, or a malformed secret ref', async () => {
    const { sessions } = build({ secrets: async () => 'x' });
    await sessions.navigate(ALICE, 'https://portal.vendor.com/', 5000);
    await expectBrowserError(
      sessions.run(
        ALICE,
        [{ kind: 'type', ref: 'e1', text: 'a', secret: { name: 'v', field: 'p' } }],
        5000
      ),
      'bad_request'
    );
    await expectBrowserError(
      sessions.type(ALICE, 'e1', undefined, false, 5000, 'vendor-portal.password'),
      'bad_request'
    );
    await sessions.shutdown();
  });
});

describe('lifetime', () => {
  it('evicts the least recently used session past the cap', async () => {
    const { sessions, browsers, clock } = build({ maxSessions: 2 });
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    clock.now += 1000;
    await sessions.navigate(BOB, 'https://example.com/', 5000);
    clock.now += 1000;
    await sessions.snapshot(ALICE, 5000); // alice is now the more recent
    clock.now += 1000;
    await sessions.navigate(
      { tenantId: 'tenant-1', subject: 'auth0|carol' },
      'https://example.com/',
      5000
    );
    expect(sessions.sessionCount()).toBe(2);
    expect(browsers[0].contexts[1].close).toHaveBeenCalled(); // bob
    expect(browsers[0].contexts[0].close).not.toHaveBeenCalled(); // alice
    // Bob's next verb reopens where he was rather than refusing.
    const reopened = await sessions.snapshot(BOB, 5000);
    expect(reopened.url).toBe('https://example.com/');
    expect(sessions.sessionCount()).toBe(2);
    await sessions.shutdown();
  });

  it('sweeps idle sessions and releases the browser once none remain', async () => {
    const { sessions, browsers, clock } = build({ idleMs: 1000, sweepIntervalMs: 15 });
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    clock.now += 5000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sessions.sessionCount()).toBe(0);
    expect(browsers[0].contexts[0].close).toHaveBeenCalled();
    expect(browsers[0].close).toHaveBeenCalled();
    // The next caller gets a fresh browser.
    await sessions.navigate(BOB, 'https://example.com/', 5000);
    expect(browsers).toHaveLength(2);
    await sessions.shutdown();
  });

  it('reopens a lost session where it left off, with the refs the model holds', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/jobs', 5000);
    const before = browsers[0].contexts[0].openPages[0];
    before.walk = {
      nodes: [
        { role: 'textbox', ref: 'e1', name: 'Search jobs' },
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'text' as const, name: `row ${i}` })),
      ],
      truncated: false,
    };
    await sessions.snapshot(ALICE, 5000);
    // The browser dies between two calls.
    browsers[0].connected = false;
    browsers[0].emit('disconnected');
    expect(sessions.sessionCount()).toBe(0);

    // The next verb reopens the page in a fresh browser and resolves the
    // old ref on it by signature (the fresh page numbers it e2).
    const field = fakeLocator(1);
    onPageCreated = (fresh) => {
      fresh.walk = {
        nodes: [
          { role: 'button', ref: 'e1', name: 'Accept cookies' },
          { role: 'textbox', ref: 'e2', name: 'Search jobs' },
          ...Array.from({ length: 8 }, (_, i) => ({ role: 'text' as const, name: `row ${i}` })),
        ],
        truncated: false,
      };
      const probed = fakeLocator(1);
      probed.evaluate.mockImplementation(async () => {
        fresh.locators.set('[data-renkei-ref="e1"]', field);
      });
      fresh.locators.set('[data-renkei-probe="e2"]', probed);
    };
    const state = await sessions.type(ALICE, 'e1', 'nurse', false, 5000);
    onPageCreated = null;
    const after = browsers[1].contexts[0].openPages[0];
    expect(after.goto).toHaveBeenCalledWith('https://example.com/jobs', {
      waitUntil: 'domcontentloaded',
    });
    expect(field.fill).toHaveBeenCalledWith('nurse');
    expect(state.url).toBe('https://example.com/jobs');
    expect(browsers).toHaveLength(2);
    await sessions.shutdown();
  });

  it('refuses with the reason and uptime when there is nothing to reopen', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    // A close on request means "done with the site": nothing is remembered.
    await sessions.close(ALICE);
    const closed = await expectBrowserError(sessions.snapshot(ALICE, 5000), 'no_session');
    expect(closed.message).toContain('was closed');
    expect(closed.message).toMatch(/worker up \d+m, browser up \d+m, 0 session\(s\) open/);
    expect(closed.message).toContain('sandbox_browser_run');
    // Never opened at all: plain refusal, still with uptime.
    const never = await expectBrowserError(sessions.snapshot(BOB, 5000), 'no_session');
    expect(never.message).toContain('No page is open.');
    expect(browsers).toHaveLength(1);
    await sessions.shutdown();
  });

  it('refuses when reopening fails, naming both the loss and the failure', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    browsers[0].connected = false;
    browsers[0].emit('disconnected');
    onPageCreated = (fresh) => fresh.goto.mockRejectedValueOnce(new Error('net::ERR_FAILED'));
    const error = await expectBrowserError(sessions.snapshot(ALICE, 5000), 'no_session');
    onPageCreated = null;
    expect(error.message).toContain('browser process exited unexpectedly');
    expect(error.message).toContain('Reopening example.com failed');
    expect(sessions.sessionCount()).toBe(0);
    await sessions.shutdown();
  });

  it('reopens after an idle close or an eviction too', async () => {
    const { sessions, browsers, clock } = build({
      idleMs: 1000,
      sweepIntervalMs: 15,
      maxSessions: 1,
    });
    await sessions.navigate(ALICE, 'https://example.com/a', 5000);
    await sessions.navigate(BOB, 'https://example.com/b', 5000);
    expect(sessions.sessionCount()).toBe(1);
    const evicted = await sessions.snapshot(ALICE, 5000);
    expect(evicted.url).toBe('https://example.com/a');
    expect(browsers[0].contexts).toHaveLength(3);
    clock.now += 5000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sessions.sessionCount()).toBe(0);
    const idle = await sessions.snapshot(BOB, 5000);
    expect(idle.url).toBe('https://example.com/b');
    await sessions.shutdown();
  });

  it('shutdown closes contexts, browser and proxy, and refuses further work', async () => {
    const proxyClose = jest.fn(async () => undefined);
    const { sessions, browsers } = build({ proxy: async () => ({ port: 9, close: proxyClose }) });
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    await sessions.shutdown();
    expect(browsers[0].contexts[0].close).toHaveBeenCalled();
    expect(browsers[0].close).toHaveBeenCalled();
    expect(proxyClose).toHaveBeenCalled();
    await expectBrowserError(
      sessions.navigate(ALICE, 'https://example.com/', 5000),
      'browser_unavailable'
    );
  });
});
