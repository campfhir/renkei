/**
 * How the worker starts Chromium, for the browser tools (browser.ts) and the
 * chart renderer (charts.ts) alike.
 *
 * The worker is root so it can drop each caller's commands to their own
 * uid; the browser, which parses arbitrary pages, must not inherit that. As
 * root, Chromium is started through docker/sandbox-browser-launcher.sh
 * (SANDBOX_BROWSER_LAUNCHER, set by the image), which execs the real binary
 * as an unprivileged uid. Playwright adds `--no-sandbox` unless
 * `chromiumSandbox` is true, so Chromium's own sandbox is switched on
 * whenever that uid can make a user namespace (the same capability the
 * script runner's `userns` network isolation needs); where it cannot, the
 * browser still runs unprivileged, and the log says its own sandbox is off.
 * SANDBOX_BROWSER_CHROMIUM_SANDBOX=true|false overrides the probe.
 */
import { spawn } from 'node:child_process';
import { chromium, type LaunchOptions } from 'playwright-core';
import { logger } from './logger';

const DEFAULT_BROWSER_UID = 1002;

export interface BrowserLaunchPlan {
  executablePath?: string;
  env?: Record<string, string>;
  chromiumSandbox: boolean;
  /** Set when the browser runs as root, for the log. */
  warning?: string;
}

export function planBrowserLaunch(input: {
  env: NodeJS.ProcessEnv;
  isRoot: boolean;
  /** Whether the browser uid can create a user namespace. */
  userns: boolean;
}): BrowserLaunchPlan {
  const { env, isRoot, userns } = input;
  const pinned = env.SANDBOX_BROWSER_EXECUTABLE?.trim() || undefined;
  const launcher = env.SANDBOX_BROWSER_LAUNCHER?.trim() || undefined;
  const override = env.SANDBOX_BROWSER_CHROMIUM_SANDBOX?.trim().toLowerCase();
  const wantSandbox = override === 'true' ? true : override === 'false' ? false : userns;

  if (isRoot && launcher) {
    return {
      executablePath: launcher,
      // Unset, the launcher finds the headless shell the image installs.
      ...(pinned ? { env: { SANDBOX_BROWSER_BINARY: pinned } } : {}),
      chromiumSandbox: wantSandbox,
    };
  }
  return {
    ...(pinned ? { executablePath: pinned } : {}),
    // Without the launcher a root browser cannot use Chromium's sandbox
    // (it refuses to start as root with it on).
    chromiumSandbox: isRoot ? false : wantSandbox,
    ...(isRoot ? { warning: 'the browser runs as root: SANDBOX_BROWSER_LAUNCHER is not set' } : {}),
  };
}

let usernsProbe: Promise<boolean> | null = null;

/** Whether an unprivileged uid can create a user namespace here, probed once. */
export function browserUserNamespaces(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  usernsProbe ??= new Promise<boolean>((resolve) => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      // Not root: the browser is this process's own uid; ask it directly.
      const child = spawn('unshare', ['-U', 'true'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
      return;
    }
    const uid = String(Number(env.SANDBOX_BROWSER_UID) || DEFAULT_BROWSER_UID);
    const child = spawn(
      'setpriv',
      [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', 'unshare', '-U', 'true'],
      { stdio: 'ignore' }
    );
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return usernsProbe;
}

/** Test-only: forget the cached probe. */
export function resetBrowserUserNamespacesForTests(): void {
  usernsProbe = null;
}

/** playwright-core's chromium, started unprivileged where the worker is root. */
export async function launchChromium(options: LaunchOptions) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const plan = planBrowserLaunch({
    env: process.env,
    isRoot,
    userns: await browserUserNamespaces(),
  });
  if (plan.warning) logger.warn('{warning}', { warning: plan.warning });
  if (!plan.chromiumSandbox) {
    logger.warn(
      "Chromium's own sandbox is off (no unprivileged user namespaces here, or SANDBOX_BROWSER_CHROMIUM_SANDBOX=false)",
      {}
    );
  }
  return chromium.launch({
    ...options,
    ...(plan.executablePath ? { executablePath: plan.executablePath } : {}),
    ...(plan.env ? { env: { ...process.env, ...plan.env } } : {}),
    chromiumSandbox: plan.chromiumSandbox,
  });
}
