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
  locator: (selector: string) => { first: () => FakeLocator };
  keyboard: { press: jest.Mock };
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
  };
}

function fakePage(url = 'about:blank'): FakePage {
  const page: FakePage = {
    currentUrl: url,
    closed: false,
    walk: { nodes: [{ role: 'heading', level: 1, name: 'Fake' }], truncated: false },
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
    evaluate: jest.fn(async () => page.walk),
    locator: (selector: string) => {
      const existing = page.locators.get(selector);
      const locator = existing ?? fakeLocator(0);
      if (!existing) page.locators.set(selector, locator);
      return { first: () => locator };
    },
    keyboard: { press: jest.fn(async () => undefined) },
    screenshot: jest.fn(async () => Buffer.from('PNG-bytes')),
  };
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
    expect(state.snapshot).toBe('Page: Fake title\nURL: https://example.com/\n---\n# Fake');
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
    expect(page.evaluate).toHaveBeenCalledTimes(6);
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
    page.evaluate.mockImplementation(async () => {
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
    await expectBrowserError(sessions.snapshot(BOB, 5000), 'no_session');
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

  it('forgets every session when the browser process disconnects', async () => {
    const { sessions, browsers } = build();
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    browsers[0].connected = false;
    browsers[0].emit('disconnected');
    expect(sessions.sessionCount()).toBe(0);
    await sessions.navigate(ALICE, 'https://example.com/', 5000);
    expect(browsers).toHaveLength(2);
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
