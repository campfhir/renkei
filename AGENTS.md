<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# UI changes: add and run Playwright steps

Whenever a change touches UI (a page, a form, a component with visible
output), add or update Playwright coverage in `apps/web/e2e/*.spec.ts` as
part of that change, and actually run it — don't just write the spec and
assume it passes. This is the repo's established pattern (see
`voice.spec.ts`, `preferences-widths.spec.ts`); `llm-models.spec.ts` is a
worked example of the full shape: empty state, filling a form, mocking a
network call with `page.route`, a saved-state screenshot, and a mobile
viewport pass.

- **This suite is local-only tooling** (`apps/web/playwright.config.ts`'s
  own header comment) — it does not run in CI. Running it is still expected
  whenever UI is touched; it just has to be done by hand, not assumed from
  a green CI check.
- **Local setup** (once per environment): a Postgres 16 server with the
  `vector` extension (`apt-get install postgresql-16-pgvector` if it's not
  already on the box), a repo-root `.env.development` with `DATABASE_URL`,
  `TOKEN_ENCRYPTION_KEY`, and `LOG_ENCRYPTION_KEY` (each `openssl rand
  -base64 32`), then `pnpm --filter @renkei/db migrate`. After that,
  `npx playwright test <spec>.spec.ts --project=desktop-light` from
  `apps/web` drives everything else (dev server, sandbox stub) itself.
- **Drive it, don't just render it**: click the button, fill the form,
  trigger the network call (mock it with `page.route` when it would hit a
  real vendor/provider), and assert on the resulting UI state — not just
  that the page loaded.
- **For mobile, just resize the viewport** — `page.setViewportSize({width:
  390, height: 844})` on the pinned Chromium executable
  (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`), the way
  `preferences-widths.spec.ts` and `llm-models.spec.ts` do it. Do NOT reach
  for the `mobile` project (`devices['iPhone 14']`) for a routine UI check:
  that's a full device descriptor asking for WebKit, which isn't installed
  in this environment (see `voice.spec.ts`'s note on the same friction), so
  it adds a real chance of failing on missing-browser rather than on your
  change. The `mobile` project is for the few specs that need real device
  behavior (touch events, a mobile UA); a viewport resize is what answers
  "does this layout still work at phone width", which is nearly always the
  actual question.
- **Isolate what you create.** If a spec creates a row through the UI (not
  just reads seeded fixtures), give it its own tenant rather than reusing
  `e2e/seed.ts`'s shared one — Playwright runs projects concurrently
  against the same dev database, and a shared tenant races on uniqueness
  constraints and on any "empty state" assertion. `llm-models.spec.ts`
  derives a deterministic tenant/session per project name for exactly this
  reason; copy that pattern rather than the shared-tenant one when your
  spec writes data.
