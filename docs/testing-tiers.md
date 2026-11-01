# Testing tiers: behaviour in reducers, the browser for what only it can show

The browser suite grew into the authority on how every screen behaves: 104
specs, 343 tests, about 23,000 lines, eleven minutes on four workers, and
the one required check on a pull request. A press that Chrome routes to an
old frame, an animation a busy runner stretches, or one spec overwriting a
setting another reads fails a merge that changed nothing near it. And the
rules it checks — what Save sends, what a refused delete leaves selected —
are slow and indirect to reach through a page.

So behaviour moves into reducers tested in node, and the browser suite
shrinks to what only a browser can show. AGENTS.md ("UI models", "UI
changes") holds the rules; this is the plan and its progress.

## The tiers

| Tier                  | What it shows                                                          | Where                                                 | Gates a merge                         |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| Model tests           | What a screen does with each input and answer                          | `*.model.test.ts` beside the component                | yes (`checks`)                        |
| Route and store tests | What the server answers, stores and refuses                            | `app/api/**/route.test.ts`, `lib/**`, store scenarios | yes (`checks`, `data store`)          |
| Browser smoke         | The app renders, routes and keeps one path per area working end to end | `e2e/*.spec.ts`, tests tagged `@smoke`                | yes (`e2e (memory store)`)            |
| Full browser suite    | Everything else in `e2e/`, while it still exists                       | `e2e/*.spec.ts`                                       | no: advisory, on every PR and on main |

The cost difference is the point: `pnpm test` runs 4,400 tests in 40
seconds (about 9 ms each); the browser suite spends about 2 seconds of a
busy worker per test, roughly 200 times as much, and is the only tier that
flakes.

## How a screen moves

1. Write `<component>.model.ts`: the state the component holds, an action
   per thing the person does and per answer the server gives, a reducer,
   and selectors for what the screen derives. No React, DOM, clock or
   network (`lib/ui-models.seam.test.ts` holds that).
2. Write `<component>.model.test.ts` from what the spec checks and what
   the component's handlers decide, in the words of someone using it.
3. Point the component at it: `useReducer`, calls in the component, each
   outcome dispatched.
4. Shrink the spec: delete the steps the model tests now own, keep what is
   browser-only (layout at a phone's width, focus, a real redirect) and at
   most one press that proves the component is wired to its model. Say in
   the spec's header where its rules went.
5. A spec whose assertions were all rules and server answers goes away
   entirely once the model and route tests cover them; the crawl
   (`e2e/crawl/`) still opens its page.

Done so far: `chips.model.ts` and `email-compose.model.ts` (preview cards;
`schedule-card.spec.ts` lost its rules test) and
`knowledge-panel.model.ts` (the first React panel; moving it found a stale
selection surviving a single delete, now fixed).
`act-preview.model.ts` (the act preview card; `act-preview.spec.ts` lost
its cancel test, and moving it found an event's end time read by the
viewer's time zone, now fixed).
`issue-preview.model.ts` (the Jira/JSM card) and `widget-card.model.ts`
(the chat's host for every card) took the rules out of
`widget-card.spec.ts`, `widget-card-resolve.spec.ts` and
`jsm-create-request-card.spec.ts`; the stale-card refusal and the
two-cards-one-turn rule are route tests beside `widget/tool-call` and
`widget/model-context`.
`directory-action-preview.model.ts` and the discard rules in
`email-compose.model.ts` shrank `directory-action-preview.spec.ts` and
`email-card-discard.spec.ts`. `mockup-viewer.model.ts` and
`mockup-card.model.ts` took zoom, widths and pan out of `mockups.spec.ts`
(the mockup route's headers are a route test now), and found Fit to width
returning to a stale scroll spot, now fixed. With those, wave 1 is done.

## The order

From a read of every spec (what share of its assertions are rules, server
answers, or browser-only) and how often it has flaked in CI. Each wave is
a set of independent pull requests, one screen each.

**Wave 1: preview cards in iframes** (the flakiest group: presses in
frames, `pointerReaches`, retry loops)

- `lib/mcp-widgets/src/act-render.ts` / `act-card.ts`: editable rewrite,
  confirm and cancel, confirm arguments, JSM pick lists → shrinks
  `act-preview`, `jsm-create-request-card`, `directory-action-preview`.
- `email-compose.ts`, the rest: discard and still-editable state →
  `email-card-discard`.
- `issue-preview.ts` with `widget-card.tsx`: decided, cancelled, stale,
  receipt → `widget-card`, `widget-card-resolve` (keep the one confirm
  path tagged `@smoke`).
- `mockup-viewer.tsx`: zoom, width and pan state (`clampZoom` and
  `stepped` are already pure) → `mockups`; its CSP checks become a route
  test.

**Wave 2: the chat** (most used, most specs)

- `composer.tsx` (19 `useState`): the queue, Stop vs Queue, attachment
  staging and the mass-upload threshold, the time zone sent, dictation →
  `chat-compaction`, `mass-upload`, `chat-time-zone`, parts of
  `artifacts` and `voice`.
- `message-list.tsx` / `lib/chat/chat-view.ts`: copy formats, folds and
  milestones, sub-agent and permission cards → `chat-copy`,
  `host-tool-cards`, `chat-subagent`, `code-subagent`, `chat-title`,
  `chat-permission`.
- `voice-mode.tsx`, `voice-picker.tsx`, `voice-menu.tsx`: the voice
  session's phases and barge-in queue → `voice`, `voice-barge-in`,
  `voice-pickers` (keep one round trip).
- `global-shortcuts.tsx`: switcher order and walk, key caps per OS →
  `global-shortcuts` (keep keyboard routing).

**Wave 3: admin forms** (rich rules, rarely flaky, slow)

- `admin/llm-models/model-forms.tsx`: the surface and provider field
  matrix, token counts, default rules → `llm-models`.
- `admin/connectors/forms/salesforce-form.tsx`, `atlassian-forms.tsx`,
  `entra-developer-form.tsx`, `voice-form.tsx`, the AD Manager and file
  share forms → `salesforce`, `salesforce-admin`, `bitbucket-webhook-hint`,
  `entra-developer`, `admanager`, `file-shares`, `code-services`.
- `admin/settings/settings-form.tsx` → `organization-name`,
  `phi-covered-model`, `sandbox-settings`, `agent-approval-policy`,
  `sandbox-size-requests` (mostly route tests).

**Wave 4: lists, libraries and builders**

- The artifacts library (`artifacts-index`, `artifact-dialogs`,
  `artifact-bulk-dialogs`, `artifacts-card`) → `artifacts` (the largest
  spec, 1,100 lines), `code-project-artifacts`.
- `notifications-list.tsx` → `notifications`, `chat-notifications`.
- `agents/builder/agent-builder.tsx` (28 `useState`) and
  `question-actions.tsx` → `agent-instructions`.
- The coach marks provider and overlay (route them through the already
  tested `lib/coach-marks/select.ts`) → `coach-marks`, `coach-marks-off`.
- Code: `repo-tree`, `add-files-modal`, `upload-queue`, `pipelines-page`,
  `branch-switcher`, `new-code-project` → `code-file-management`,
  `code-uploads`, `code-pipelines`, `branch-switcher`, `code`.

**Alongside: server answers checked through a page.** These specs are
mostly what a route returns or stores, and move to route tests on the
memory store with no component change: the `jira-admin-*` family,
`my-usage`, `security-headers`, `activity-logs`, `code-concurrent-chats`,
`oauth-consent`'s PKCE refusals, `access-revoke-sessions`, `chat-archive`.

## Where it ends

About fifteen browser tests tagged `@smoke` and the page crawl gate a
merge (that is where it starts, too: `pnpm --filter renkei e2e:smoke`), plus
a handful of layout and visual sweeps (`preferences-widths`,
`nav-chat-scroll`, `screenshots`) that never gate. When waves 1 and 2 are
done, the full suite moves off pull requests to main and a nightly run.

## Decisions to revisit

- **Branch protection** must require `checks` and `e2e (memory store)`
  (now the smoke tier) and not the `e2e shard i/3` jobs, or the full
  suite is still a gate.
- **Component tests with a DOM** (jsdom and Testing Library) are not
  adopted: a model test covers the rules without one, and what a model
  cannot show is mostly what jsdom cannot either (layout, real focus,
  frames). Revisit if wiring bugs between component and model start
  slipping past the smoke tier.
