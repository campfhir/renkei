/**
 * A lock across the suite's workers, for a spec that flips an
 * organization-wide switch the other tests read. There is one
 * organization per server, and every worker of every project signs in
 * to it, so a test that turns the guided tours off (or changes the
 * act-approval policy) would change what a test in another worker sees
 * mid-step.
 *
 *   const release = await holdExclusive('tours'); // the one flipping it
 *   const release = await holdShared('tours');    // one relying on it
 *
 * Any number of shared holders run side by side; an exclusive holder
 * waits for them to finish and keeps new ones out until it releases.
 * The lock is a directory and files under the run's output directory,
 * which Playwright empties when a run starts, so nothing outlives a run.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory', '.locks');
const POLL_MS = 200;

const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));
const exclusivePath = (name: string) => path.join(DIR, `${name}.exclusive`);

async function entries(): Promise<string[]> {
  return readdir(DIR).catch((): string[] => []);
}

async function sharedHolders(name: string): Promise<string[]> {
  const listed = await entries();
  return listed.filter((entry) => entry.startsWith(`${name}.shared.`));
}

async function exclusiveHeld(name: string): Promise<boolean> {
  return (await entries()).includes(`${name}.exclusive`);
}

export type Release = () => Promise<void>;

export async function holdExclusive(name: string): Promise<Release> {
  await mkdir(DIR, { recursive: true });
  for (;;) {
    try {
      await mkdir(exclusivePath(name));
      break;
    } catch {
      await pause();
    }
  }
  while ((await sharedHolders(name)).length > 0) await pause();
  return () => rmdir(exclusivePath(name));
}

export async function holdShared(name: string): Promise<Release> {
  await mkdir(DIR, { recursive: true });
  const mine = path.join(DIR, `${name}.shared.${randomUUID()}`);
  for (;;) {
    while (await exclusiveHeld(name)) await pause();
    await writeFile(mine, '');
    // An exclusive holder that came in between waits on this file; step
    // aside for it rather than deadlock.
    if (!(await exclusiveHeld(name))) break;
    await rm(mine, { force: true });
    await pause();
  }
  return () => rm(mine, { force: true });
}
