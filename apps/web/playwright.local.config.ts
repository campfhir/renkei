/**
 * The screenshot config for a Claude Code on the web session: the same
 * projects as playwright.config.ts, on the Chromium this container ships
 * (the path voice.spec.ts pins too) rather than the build the pinned
 * Playwright would download, and Chromium for the mobile project as
 * well, since WebKit is not installed here. Use with
 * `npx playwright test --config playwright.local.config.ts`; elsewhere,
 * the ordinary config.
 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  projects: (base.projects ?? []).map((project) => ({
    ...project,
    use: {
      ...project.use,
      browserName: 'chromium',
      launchOptions: {
        executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        // Root in the container: Chromium refuses its sandbox there.
        args: ['--no-sandbox'],
      },
    },
  })),
});
