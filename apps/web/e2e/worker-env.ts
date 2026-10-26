/**
 * Each Playwright worker runs against its own stack: a database, a delegate and
 * a dev server, started once in global setup (stacks.ts). The worker points
 * `process.env.DATABASE_URL` at its database, so the specs' own clients connect
 * there too, and takes its base URL from its stack.
 *
 * Specs opt in by importing from here instead of '@playwright/test'. Everything
 * else the specs take from Playwright is re-exported unchanged.
 */

import { test as base } from '@playwright/test';
import { readStack } from './stacks';

export * from '@playwright/test';

export const test = base.extend<{ baseURL: string }, { stack: ReturnType<typeof readStack> }>({
  stack: [
    async ({}, use, workerInfo) => {
      const stack = readStack(workerInfo.parallelIndex);
      process.env.DATABASE_URL = stack.databaseUrl;
      process.env.E2E_DELEGATE_URL = stack.delegateUrl;
      await use(stack);
    },
    { scope: 'worker', auto: true },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.baseURL);
  },
});
