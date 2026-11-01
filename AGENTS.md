<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# UI models: a screen's behaviour is a reducer, tested in node

What a screen does — which fields a form enables, what a card adds or takes
off, what a list shows after a click, what request Save sends, what an
error leaves on screen — lives in a `*.model.ts` beside the component: a
state type, an action union, a reducer, and selectors for what the screen
derives (`canSave`, the select-all box, the request body). The component
holds `useReducer(reducer, props, init)`, makes the calls, dispatches what
the person did and what the server answered, and renders. The model's
`*.model.test.ts` beside it is the authority on that behaviour, runs in
milliseconds in `pnpm test`, and gates every merge.

- **Worked examples:** `app/(app)/agents/[agentId]/knowledge-panel.model.ts`
  (a React panel: list, selection, draft form, deletes) and, for the
  preview cards drawn in iframes (plain TypeScript, not React),
  `lib/mcp-widgets/src/email-compose.model.ts` (what Send sends, what is
  refused) and `chips.model.ts`. `lib/chat/stream-events.ts` is the
  oldest: the chat thread's stream reducer, shared with the server.
- **A model is pure.** `lib/ui-models.seam.test.ts` fails a `*.model.ts`
  that imports React, Next, a component or the data store, touches
  `window`/`document`/storage, fetches, sets a timer, reads the clock or
  draws a random id — pass the time or id in an action — or has no
  `*.model.test.ts` beside it.
- **Write the test as the screen's spec**, in the words a person would use
  ("a refused delete keeps the selection and shows why"): a sequence of
  actions folded through the reducer, then the state or a selector.
- **When you change a screen**, change or add its model and model tests in
  the same change. A component with rules still inline (`useState` and
  handlers deciding things) gets its model when you next change those
  rules; the order the rest move in is `docs/testing-tiers.md`.

# UI changes: the browser suite shows what only a browser can

The Playwright suite in `apps/web/e2e/*.spec.ts` is for what a model test
cannot show: that a page renders on the real server, routes and redirects,
fits a phone, keeps focus and keyboard where they belong, and that one path
end to end — a press in, the right request out, the answer drawn — reaches
the server. Add or update a spec when a change touches one of those, and
actually run it — don't just write the spec and assume it passes. A rule
("Save is off until both fields say something") goes in the model test,
not a press.

Two tiers (`.github/workflows/ci.yml`): the tests tagged `@smoke` in their
title (`pnpm --filter renkei e2e:smoke`), one critical path per area and
the page crawl, gate a merge as `e2e (memory store)`; the full suite runs
beside them on every pull request and on main as an advisory signal.
Tag a test `@smoke` only for a new critical path no smoke test walks.
`llm-models.spec.ts` shows the harness end to end (empty state, a form, a
vendor call answered with `page.route`, a saved-state screenshot, a
phone-width pass); its form rules are next to move into a model.

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
  passes when every shard does. The suite runs Playwright's full
  Chromium build headless (`channel: 'chromium'`), never its headless
  shell, which routes a redirected navigation past `page.route` and
  denies notifications. On a box whose Chromium doesn't match
  Playwright's, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a full Chrome.
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
- **No motion to wait out.** The suite runs with the OS's reduce-motion
  on (`reducedMotion` in `playwright.config.ts`), and the app ends every
  transition and animation at once under it (`app/globals.css`), so a
  slow CI CPU cannot stretch a slide or fade past a step's timeout. A
  context a spec opens itself (`browser.newContext`) passes
  `reducedMotion: 'reduce'` too. New motion respects the setting
  (`motion-safe:`, or `scrollMotion()` from `lib/hash-scroll.ts` for a
  scripted scroll).
- **Rules go in model tests, not presses** ("UI models", above). The spec
  drives only the path end to end: a value in, the right request out.
  Every press in an iframe is a chance for Chrome to route it by an old
  frame.
- **Shared org state is written the same by everyone.** A setting one
  spec needs and another overwrites (a connector's scopes, the
  organization default model) is a race, not a slow server: pin it where
  it is written (`SHARED_SETTINGS` in `e2e/support/connectors.ts`), or
  leave it untouched and answer the read with `page.route`
  (`llm-models.spec.ts`'s default badge).
- **Pitfalls.** A built app can hold hidden copies of a page's
  pieces (a streamed render, a responsive twin): scope to
  `getByRole('main')` or add `.filter({ visible: true })`. Chrome routes
  a press by what it last drew, not by the DOM: before pressing on
  something that has just appeared over or inside an iframe, wait with
  `pointerReaches` (`e2e/support/settle.ts`). A dev server
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

# Type guards: `@renkei/guards`

Narrowing an `unknown` (a JSON body, a vendor's answer, a postMessage, an
error's cause) uses `isRecord`, `asRecord`, `recordOrNull` and `isString`
from `@renkei/guards` (`packages/guards`), in every app and package, the
preview cards' bundles included. `isRecord` is an object that is not null
and not an array. A local copy fails `packages/guards/src/no-copies.test.ts`;
a new general guard goes into the package with a test, not into a module.

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
