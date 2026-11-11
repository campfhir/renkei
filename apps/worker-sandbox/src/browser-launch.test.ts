import { planBrowserLaunch } from './browser-launch';

const LAUNCHER = '/usr/local/bin/sandbox-browser-launcher';

describe('planBrowserLaunch', () => {
  it('starts the browser through the launcher when the worker is root', () => {
    const plan = planBrowserLaunch({
      env: { SANDBOX_BROWSER_LAUNCHER: LAUNCHER },
      isRoot: true,
      userns: true,
    });
    expect(plan).toEqual({ executablePath: LAUNCHER, chromiumSandbox: true });
  });

  it('hands the launcher a pinned browser binary', () => {
    const plan = planBrowserLaunch({
      env: { SANDBOX_BROWSER_LAUNCHER: LAUNCHER, SANDBOX_BROWSER_EXECUTABLE: '/opt/chrome' },
      isRoot: true,
      userns: true,
    });
    expect(plan.env).toEqual({ SANDBOX_BROWSER_BINARY: '/opt/chrome' });
  });

  it("leaves Chromium's own sandbox off only where user namespaces are unavailable", () => {
    const env = { SANDBOX_BROWSER_LAUNCHER: LAUNCHER };
    expect(planBrowserLaunch({ env, isRoot: true, userns: false }).chromiumSandbox).toBe(false);
  });

  it('lets the operator override the probe either way', () => {
    const base = { SANDBOX_BROWSER_LAUNCHER: LAUNCHER };
    expect(
      planBrowserLaunch({
        env: { ...base, SANDBOX_BROWSER_CHROMIUM_SANDBOX: 'false' },
        isRoot: true,
        userns: true,
      }).chromiumSandbox
    ).toBe(false);
    expect(
      planBrowserLaunch({
        env: { ...base, SANDBOX_BROWSER_CHROMIUM_SANDBOX: 'true' },
        isRoot: true,
        userns: false,
      }).chromiumSandbox
    ).toBe(true);
  });

  it('warns when a root worker has no launcher, and never asks a root browser to sandbox', () => {
    const plan = planBrowserLaunch({ env: {}, isRoot: true, userns: true });
    expect(plan.chromiumSandbox).toBe(false);
    expect(plan.warning).toMatch(/runs as root/);
  });

  it('uses its own uid and the sandbox when the worker is not root', () => {
    const plan = planBrowserLaunch({ env: {}, isRoot: false, userns: true });
    expect(plan).toEqual({ chromiumSandbox: true });
  });
});
