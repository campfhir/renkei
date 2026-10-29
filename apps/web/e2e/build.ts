/**
 * `pnpm e2e:build`: a production build of the web app with the memory
 * server's environment (e2e/server-env.ts). CI builds once with it, and
 * each shard starts that build with E2E_PREBUILT=1 (playwright.config.ts).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { memoryServerEnv } from './server-env';

execFileSync('pnpm', ['build'], {
  cwd: path.join(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, ...memoryServerEnv() },
});
