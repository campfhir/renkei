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
  `TOKEN_ENCRYPTION_KEY` and `LOG_ENCRYPTION_KEY` (each `openssl rand
-base64 32`; `USER_KEY_ENCRYPTION_KEY` is optional and migration-only —
  people hold their own keys, and `e2e/keys.ts` enrolls a spec's person the
  way a browser would, against the delegate the config starts), plus
  `SANDBOX_WORKER_URL=http://127.0.0.1:8092`,
  `SANDBOX_WORKER_API_KEY=e2e-sandbox-key` so the sandbox stub is reachable
  (which sandbox features the seeded organization gets — code workspaces,
  services, the browser, charts — is written by `e2e/seed.ts` as org
  settings, not by environment variables); then
  `pnpm --filter @renkei/db migrate`. File storage needs nothing: the
  Playwright config points the dev server at the blob store's `local`
  backend (`packages/blob-store/src/local.ts`, files under
  `apps/web/test-results/blobs`) unless `BLOB_STORE_PROVIDER` is already
  set, so uploads, downloads and text extraction run for real in a spec
  and the composer's paperclip is on screen. After that,
  `npx playwright test <spec>.spec.ts --project=desktop-light` from
  `apps/web` drives everything else (dev server, sandbox stub, the
  delegate worker) itself.
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
  just reads seeded fixtures), give it its own person rather than reusing
  `e2e/seed.ts`'s shared session — Playwright runs projects concurrently
  against the same dev database, and a shared subject races on uniqueness
  constraints and on any "empty state" assertion. `llm-models.spec.ts`
  derives a deterministic subject/session per project name for exactly
  this reason; copy that pattern rather than the shared-session one when
  your spec writes data, and clear your person's rows with
  `deleteRowsOf(client, subject, tables)` from `e2e/seed.ts`. There is one
  organization per deployment, so organization-wide tables (`settings`,
  `connector_configs`, `llm_model_configs`, `oauth_clients`) are shared by
  every spec in a run: a spec that writes one of them cannot assume an
  empty state and should keep its own writes distinctive.

# The data store seam: pages read through `getDataStore()`

`@renkei/db` exposes a data store (`packages/db/src/store/`): domain-shaped
repositories under `store/domains/<name>/` (types, `postgres.ts`,
`memory.ts`, `scenarios.ts`), each with a Postgres implementation and an
in-memory JavaScript one. The memory store keeps rows shaped exactly as
Postgres returns them, in tables built from a schema generated off the
migrations (`store/schema.generated.ts`): defaults, keys, foreign keys and
cascades behave as they do in the database.

- **Nothing outside `packages/db` touches the database: pages, API
  routes, workers, shared packages and their scripts call
  `getDataStore()`, never `getDatabase()`/`getPool()`.** On the memory store,
  `getDatabase()` fails and records its caller; the crawl spec
  (`apps/web/e2e/memory/crawl.spec.ts`) loads every page and fails when one
  reached the database directly. A new page gets a `CrawlPage` entry in
  `e2e/memory/crawl/<area>.ts`. Statically, `packages/db/src/store/seam.test.ts`
  scans every app and package and fails any non-test module that calls
  `getDatabase()`/`getPool()`, imports `kysely` or `pg`, or builds a
  query; a file that truly needs the pg handle is listed there with its
  reason. Tests, e2e specs and `test-support/` may still seed Postgres
  directly. Logging and boot go through `createLogAdapter`,
  `checkDataStore()` and `closeDataStore()` from `@renkei/db`.
- **A new or changed repository method** changes `types.ts`, `postgres.ts`
  and `memory.ts` together and gets at least one differential scenario in
  `scenarios.ts`: fixture rows plus a call, run against a freshly
  truncated Postgres and a fresh memory store, answers required equal.
  `coverage.test.ts` fails any method without one. Lists have a defined
  order (ties broken explicitly); business rules (access, decryption,
  defaults) stay with the caller. See `packages/db/CLAUDE.md` for running it.
- **Unit tests** register a memory store (`registerDataStore(createMemoryDataStore())`,
  seed it with table rows, `resetDataStore()` after) instead of
  hand-building Kysely chains — see `apps/web/lib/session.test.ts`.
- **The memory UI suite** (`apps/web/playwright.memory.config.ts`, specs
  in `apps/web/e2e/memory/`) runs the web app with
  `RENKEI_DATA_STORE=memory` and no Postgres or delegate:
  `pnpm --filter renkei e2e:memory`. Specs get a signed-in person from
  `e2e/memory/fixtures.ts` and add rows with `person.seed({ table: [rows] })`
  (the same columns `e2e/seed.ts` writes to Postgres), posted to the
  test-only `app/api/test/data-store` route (404 unless the memory store is
  active and the seed token matches). It runs in CI. Prefer it for layout,
  navigation and page behavior; keep the full suite for what needs the
  delegate, the stubs or a real chat turn. `E2E_MEMORY_PORT` moves its
  server; on a box whose preinstalled Chromium doesn't match Playwright's,
  set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
- Outside the web app's memory mode `getDataStore()` is the Postgres
  store, so workers and shared packages go through it like the web app.
  What only Postgres can do stays inside a store method: queue claims
  (`FOR UPDATE SKIP LOCKED`, `queues.claim`), advisory locks
  (`advisoryLocks.withTryLock`), pgvector and full-text search; the
  memory store gives single-process equivalents.
