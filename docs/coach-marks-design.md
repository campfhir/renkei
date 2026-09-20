# Coach marks — design and build plan

Working brief for the coach-mark (guided tour) system. Written first so the
work can be picked up mid-way from another session: the **Build plan** at the
bottom is a checklist, ticked as each phase lands, with the commit that landed
it.

## What it is for

Overlays in the app that teach a workflow to somebody new, or a new feature to
somebody who has been here a while. Each tour is a short sequence of steps; a
step spotlights one element on the page (or, with no target, sits centred) and
says what it is for. A person can skip a tour the moment it appears, and can
come back to any tour later from the account menu behind their avatar. Every
tour a person sees is recorded — who viewed it, who finished it, who skipped
it — so an operator can report on adoption.

## Decisions

1. **Tours are code, not data.** A tour is a typed object in
   `apps/web/lib/coach-marks/tours.ts`; steps point at UI elements through
   `data-coach="<anchor>"` attributes that pages and the nav carry. Adding a
   tour for a new feature is: add the anchors to the feature's markup, add
   the tour to the registry, done. No admin authoring UI — the tour text is
   product copy that ships with the feature it describes, and lives in the
   same commit.

2. **One engine, mounted once.** A `CoachMarkProvider` sits in the tenant
   layout (`app/[slug]/layout.tsx`) beside the nav, so a tour can spotlight
   the nav and the page alike and survive client-side navigation between
   steps. It renders the overlay through a portal to `<body>` — the same
   rule `components/modal.tsx` follows, for the same reason (the sticky
   nav column and the phone drawer each break a `position: fixed` child).
   It sits at z-[60], above the modal/toast budget of z-50 documented in
   `toast-stack.tsx`: a tour is the thing in front by definition.

3. **Auto-start rules.** A tour declares where it starts (a path under the
   slug) and whether it auto-starts. On every route change the engine
   picks the first auto-start tour, in registry order, whose start path
   matches and which this person has neither completed nor dismissed at
   the tour's current `version` — and only if their coach-mark preference
   is on. One tour per page load; nothing chains. Bumping a tour's
   `version` re-shows it to everyone (the way to teach a reworked feature).
   A tour may require the operator role.

4. **Dismissal is per tour, and there is a global switch.** "Skip tour"
   records that tour as dismissed and it does not come back. The card also
   offers "Don't show tutorials" which turns the person's preference off.
   Both are reversible from the Tutorials page.

5. **The Tutorials page** (`/[slug]/tutorials`, in the account menu) lists
   every tour the person may see with its status — Not started, In
   progress, Completed, Skipped — and a Start/Replay button, plus the
   auto-show switch. Replay navigates to the tour's start path with
   `?tour=<id>`; the engine reads that query on mount, starts the tour
   regardless of history or the preference, and cleans the URL.

6. **Progress is its own table**, `coach_mark_progress` (migration 114),
   one row per (tenant, subject, tour). A jsonb blob in `user_preferences`
   would do for "what have I seen", but the report needs to count and
   join across people, and `audit_events` explicitly refuses usage
   telemetry. Columns: `status` (`viewed` | `completed` | `dismissed`),
   `tour_version`, `step_reached`, `steps_total`, `view_count`,
   `completed_count`, `dismissed_count`, `first_viewed_at`,
   `last_viewed_at`, `completed_at`, `dismissed_at`, `updated_at`.
   Counters survive replays, so "completed once, skipped the replay" is
   still visible. The on/off preference lives in `user_preferences` under
   the `coach_marks` key (`@renkei/user-prefs`), like theme and voice.

7. **Recording is fire-and-forget from the browser.** The engine POSTs to
   `/api/tenant/[tenantId]/coach-marks` with `{ tourId, version, event,
   step }` where event is `viewed` (on start), `step` (each advance),
   `completed`, or `dismissed`. Subject comes from the session, never the
   body. A lost request loses a data point, never a tour.

8. **The report** is operator-only at `/[slug]/admin/tutorials`, linked from
   the Organization page under "People and records": per tour, how many
   viewed / completed / skipped / are mid-way and the completion rate; then
   a table of people with a column per tour, joined to `identities` for
   names, as the other admin reports do.

## Tours shipped in this build

| id           | starts on            | auto | audience  | teaches                                                  |
| ------------ | -------------------- | ---- | --------- | -------------------------------------------------------- |
| `welcome`    | `/[slug]` (home)     | yes  | everyone  | the shell: feed, workspace menu, chat, account menu      |
| `agents`     | `/[slug]/agents`     | yes  | everyone  | making an agent, importing one, what a listed agent does |
| `chat`       | `/[slug]/chat/new`   | yes  | everyone  | the composer: message, tools, model, prompts, send       |
| `connectors` | `/[slug]/connectors` | yes  | everyone  | adding a connector, the MCP endpoint                     |
| `admin`      | `/[slug]/admin`      | yes  | operators | the console's areas                                      |

## Anchors

`data-coach` values are the contract between a tour and the markup. Kept
short and stable; a tour test (`tours.test.ts`) checks every step's target
names one of these, so renaming one is caught at unit-test time rather than
as a silently untargeted step.

| anchor                | element                                     |
| --------------------- | ------------------------------------------- |
| `nav-menu-button`     | the hamburger                               |
| `nav-workspace`       | the Workspace group in the menu column      |
| `nav-chat`            | the Chat group in the menu column           |
| `nav-account`         | the avatar button                           |
| `account-tutorials`   | the Tutorials item in the account menu      |
| `home-feed`           | the actionable-items heading block          |
| `agents-new`          | the New agent button                        |
| `agents-import`       | the Import button                           |
| `agents-list`         | the list of agents                          |
| `chat-composer`       | the message box                             |
| `chat-tools`          | the Tools button                            |
| `chat-model`          | the model picker                            |
| `chat-send`           | the Send button                             |
| `connectors-add`      | the Add connector button                    |
| `connectors-endpoint` | the MCP endpoint block                      |
| `admin-sections`      | the Organization page's area grid           |

A missing or hidden target (the nav column is a drawer on a phone) degrades
to a centred card with no spotlight, so a tour never blocks on layout.

## Testing

- Unit (jest, `apps/web/lib/coach-marks/*.test.ts`): registry validity
  (unique ids, ≥1 step, every target in the anchor list, version ≥ 1);
  auto-start selection given pathname, role, progress, preference; the
  progress reducer for the API (which event moves which columns).
- `packages/user-prefs/src/prefs.test.ts`: the `coach_marks` parser.
- `packages/db` status test picks up migration 114 automatically.
- `apps/web/lib/route-auth-coverage.test.ts` holds the new page and route
  to a session guard.
- Playwright `apps/web/e2e/coach-marks.spec.ts`, screenshots under
  `test-results/screens/<project>/coach-*.png`: welcome tour appears for a
  fresh person and each step is captured; Finish records `completed` and
  the tour does not return; Skip records `dismissed`; the Tutorials page
  lists status and Replay restarts a completed tour; the auto-show switch
  suppresses; the admin report shows the rows. The spec signs in as its
  own subject per project (`e2e-coach-<project>@example.com`) so the
  shared `e2e` user — whose preference the seed sets to off — keeps every
  other spec free of overlays.

## Build plan

Tick each phase when it is committed. Each phase leaves lint, typecheck
and unit tests green on its own.

- [x] 0. Environment: local Postgres 16 + pgvector, `.env.development`,
      migrations run, baseline Playwright spec passes in the container.
- [ ] 1. Storage: migration `114-coach-mark-progress`, `EXPECTED_MIGRATIONS`,
      `db.types.ts` regenerated; `coach_marks` preference in
      `@renkei/user-prefs` (+ parser test); preferences route accepts it.
- [ ] 2. Registry + engine: `lib/coach-marks/{types,tours,select,anchor}.ts`,
      `components/coach-marks/{provider,overlay}.tsx`, mounted in the
      tenant layout; `data-coach` anchors in nav and pages; unit tests.
- [ ] 3. Recording: `POST /api/tenant/[tenantId]/coach-marks` +
      `lib/coach-marks/progress.ts` (upsert reducer + test).
- [ ] 4. Tutorials page `/[slug]/tutorials` + account-menu item + replay via
      `?tour=`.
- [ ] 5. Admin report `/[slug]/admin/tutorials` + Organization page link.
- [ ] 6. Playwright spec with screenshots (desktop-light, desktop-dark,
      mobile); seed sets the shared user's preference off.
- [ ] 7. Docs: `docs/README.md` index entry; this file's status updated.
