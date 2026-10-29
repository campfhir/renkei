<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# UI changes: add and run Playwright steps

Whenever a change touches UI (a page, a form, a component with visible
output), add or update Playwright coverage in `apps/web/e2e/*.spec.ts` as
part of that change, and actually run it — don't just write the spec and
assume it passes. `llm-models.spec.ts` is a worked example of the full
shape: empty state, filling a form, a vendor call answered with
`page.route`, a saved-state screenshot, and a phone-width pass.

- **The suite** (`apps/web/playwright.config.ts`) runs the web app on the
  in-memory data store (`RENKEI_DATA_STORE=memory`, no Postgres) with its
  delegate and the background consumers a UI flow waits on in-process
  (`lib/memory-delegate.ts`, `lib/memory-workers.ts`), beside three
  stateless stubs: the sandbox worker, which also stands in for the hosts'
  APIs (`e2e/sandbox-stub.mjs`), an MCP server (`e2e/mcp-stub.mjs`) and a
  model (`e2e/llm-stub.mjs`). From `apps/web`:
  `npx playwright test <spec> [--project=desktop-light]` starts them all
  (a dev server, reused while it is up; `E2E_MEMORY_PORT` moves it), on
  four workers. It runs in CI as a production build, as
  `env -u DATABASE_URL CI=1 npx playwright test` does locally: CI builds
  once (`pnpm e2e:build`, with the server's environment from
  `e2e/server-env.ts`) and runs three `--shard=i/3` jobs on that build
  (`E2E_PREBUILT=1` starts `.next` as it is); `e2e (memory store)`
  passes when every shard does. On a box
  whose Chromium doesn't match Playwright's, set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
- **Every spec runs in `desktop-light`; `desktop-dark` runs only
  `DARK_SPECS`** in `playwright.config.ts`: specs that look at the theme
  (the screenshot gallery, a colour asserted on dark) or take their
  phone-width path in one of the two projects. Add a spec there only for
  one of those reasons.
- **A spec is a person in a browser.** Take the `person` fixture
  (`e2e/fixtures.ts`): a fresh subject signed in through the one
  test-only route (`app/api/test/session`) with its keys enrolled, roles
  by `test.use({ roles: [...] })`. A second person is another
  `createPerson(request)` (`e2e/support/person.ts`). Stage everything
  else through the REST routes the UI itself calls, with `page.request`
  (`POST /api/agents`, `/api/chat/chats` and `…/turns`, the admin
  routes; `e2e/support/` has the common ones). Specs import nothing of
  `@renkei/db` and write no SQL — `packages/db/src/store/seam.test.ts`
  holds `e2e/` to that.
- **Connectors connect for real** on fake grants
  (`packages/provider-grants/src/fake-oauth.ts`): register the org's app
  and follow the card's authorize route — `connectThrough`, `connectJira`
  (`e2e/support/connectors.ts`), `connectCodeHost` (`code-host.ts`). What
  only a vendor's own server produces is answered at the browser edge
  with `page.route`; a page whose data only a background loop writes
  shows its empty state.
- **The model is scripted where it is sent.** `addStubModel`
  (`e2e/support/stub-model.ts`) puts the stub on the roster; it answers
  the fixed `LLM_STUB_REPLY` (an agent run gets `finish_run`). To make it
  call tools, think, report usage or take its time, put a script block in
  an agent's instructions (`stubScript(steps)`) or append it to a prompt
  (`scripted(text, steps)`): each step is one reply, a tool round trip
  apart. The format is in `llm-stub.mjs`'s header.
- **Drive it, don't just render it**: click the button, fill the form,
  and assert on the resulting UI state — not just that the page loaded.
- **For mobile, just resize the viewport** —
  `page.setViewportSize({ width: 390, height: 844 })`, as
  `preferences-widths.spec.ts` does. There is no WebKit here; a spec that
  needs one (`voice-webkit.spec.ts`) skips without it.
- **Isolate what you create.** Per-person rows need no cleanup: nobody
  else has the subject. Organization-wide rows are shared by every test
  and both projects on the one server — models, connector configs, org
  settings, file shares, MCP servers — and agent names are unique
  org-wide: tag yours (`${testInfo.project.name}-${randomUUID().slice(0, 6)}`),
  scope assertions to them, delete them through the UI's own route
  afterwards, and never assert an org-wide list is empty from real data
  (answer it with `page.route`). A registration other specs connect
  through is switched on and left on, written the same by everyone.
- **Wait on the page, not the clock.** The org's settings, connector
  configs and model roster are cached for a minute in each server bundle
  in production; the suite sets `RENKEI_CONFIG_CACHE_TTL_MS=0`, so a
  switch a spec flips shows on the next request — assert it, don't poll
  for it. No `waitForTimeout`: wait for a response, a locator state, or
  `settled`/`painted`/`steady` (`e2e/support/settle.ts`). A model reply
  that must stay in flight while the test looks holds `until` a key the
  test lets go with `releaseStub`, rather than a long `delayMs`.
- **Pitfalls.** A built app can hold hidden copies of a page's
  pieces (a streamed render, a responsive twin): scope to
  `getByRole('main')` or add `.filter({ visible: true })`. A dev server
  whose pages reload in a loop (`page.goto` waiting on navigation after
  navigation, `✓ Compiled` over and over in its log) is running on a
  stale `.next/dev` — typically after files moved or dependencies changed
  under it: stop it, delete `apps/web/.next/dev`, start again. `next dev`
  also reloads every page when its environment changes, so a value the
  server needs is named in `playwright.config.ts`, never set at boot.
- **The tour walk is standalone.** `coach-marks-walk.spec.ts` walks every
  tour step by step with a screenshot each, for reviewing tour copy and
  placement; it is not in the suite or CI (`playwright.config.ts` ignores
  it unless `E2E_TOURS` is set). Run it when tours change:
  `pnpm --filter renkei e2e:tours`. `coach-marks.spec.ts` and
  `coach-marks-off.spec.ts` stay in the suite.
- **A new page** either gets a spec that opens and drives it, or a
  `CrawlPage` entry in `e2e/crawl/<area>.ts` (the crawl is the floor for
  pages no spec opens: it renders, no error page, its data shows).

# The data store seam: pages read through `getDataStore()`

`@renkei/db` exposes a data store (`packages/db/src/store/`): domain-shaped
repositories under `store/domains/<name>/` (types, `postgres.ts`,
`memory.ts`, `scenarios.ts`), each with a Postgres implementation and an
in-memory JavaScript one. The memory store is a mock, not a database:
per-table arrays of rows shaped as Postgres returns them
(`store/memory/tables.ts`), stored, then returned filtered and in each
method's documented order. It knows no columns, keys or references, and
it does not replicate foreign keys, cascades, constraint error codes or
collation (strings sort by plain code-unit order). A domain's `memory.ts`
fills the fields its records show (ids, timestamps, status defaults)
where it inserts, refuses a duplicate only where a caller turns that into
behaviour (agent names "name taken", the running-turn and run-executor
tripwires, a taken connector or template name), and removes or unlinks
the dependent rows a delete visibly takes with it, in a few explicit
lines.

- **Nothing outside `packages/db` touches the database.** The connection
  never leaves the package: `@renkei/db` exports no `getDatabase()`,
  `getPool()` or handle-taking constructor. Pages, API routes, workers,
  shared packages, their scripts and their tests all call
  `getDataStore()`; logging and boot go through `createLogAdapter`,
  `checkDataStore()` and `closeDataStore()`. Statically,
  `packages/db/src/store/seam.test.ts` scans every app and package and
  fails any module that imports `kysely` or `pg`, builds a query, or
  deep-imports past `@renkei/db`; `e2e/` directories may not import
  `@renkei/db` or write SQL at all. The crawl spec
  (`apps/web/e2e/crawl.spec.ts`) loads, on the memory store alone, the
  pages no other spec opens.
- **Tests seed with the application's own code**: a unit or database test
  creates a row the way the app creates it (`agents.create`,
  `chats.create`, `agentRuns.createQueued` then `updateExecution`, …),
  reads it back with the store's reads, and uses per-run unique ids and
  subjects instead of cleaning up with deletes. `*.db.test.ts` and other
  database-gated tests run the same calls against Postgres when
  `DATABASE_URL` is set. What only the database can show (a trigger
  refusing an UPDATE) is tested in `packages/db`, which keeps its own
  connection. A Playwright spec goes one step further out and stages
  through the app's REST routes ("UI changes", above); it never calls
  the store.
- **A new or changed repository method** changes `types.ts`, `postgres.ts`
  and `memory.ts` together and gets at least one differential scenario in
  `scenarios.ts`: fixture rows plus a call, run against a freshly
  truncated Postgres and a fresh memory store seeded with the same rows
  (the fixture as Postgres stored it), answers required equal.
  `coverage.test.ts` fails any method without one. Lists have a defined
  order (ties broken explicitly); scenario values sort alike under a
  plain compare and the database's collation (no case or accent ties).
  Business rules (access, decryption, defaults) stay with the caller. See
  `packages/db/CLAUDE.md` for running it.
- **Unit tests** register a memory store (`registerDataStore(createMemoryDataStore())`,
  `resetDataStore()` after) instead of hand-building Kysely chains — see
  `apps/web/lib/session.test.ts`. Seeding it with table rows
  (`store.seed({ table: [rows] })`) is for state the application cannot
  write any more, such as a legacy row from before a migration. A seed is
  a plain insert: rows go in as given (Dates for timestamps, parsed JSON,
  strings for int8), with no defaults filled, so a seeded row carries
  every field the test reads back.
- **The browser suite** ("UI changes", above) runs the web app on the
  memory store alone. Everything that has to share that store runs inside
  the one server, started by `instrumentation.ts`: the real delegate
  (`lib/memory-delegate.ts`) and the background consumers a UI flow waits
  on (`lib/memory-workers.ts`: the agents worker's run engine and action
  executor, and the event dispatcher, each from its worker's
  `src/embedded.ts`, woken the moment something is enqueued; no sweeps,
  ingest or schedule loops). The test-only sign-in route answers 404
  unless the memory store is active and the seed token matches, and
  connector grants are fake only there
  (`packages/provider-grants/src/fake-oauth.ts`).
- Outside the web app's memory mode `getDataStore()` is the Postgres
  store, so workers and shared packages go through it like the web app.
  What only Postgres can do stays inside a store method: queue claims
  (`FOR UPDATE SKIP LOCKED`, `queues.claim`), advisory locks
  (`advisoryLocks.withTryLock`), pgvector and full-text search; the
  memory store gives single-process equivalents.
