# Testing tiers: behaviour in reducers, the browser for what only it can show

The browser suite grew into the authority on how every screen behaves: 104
specs, 343 tests, about 23,000 lines, eleven minutes on four workers, and
the one required check on a pull request. A press that Chrome routes to an
old frame, an animation a busy runner stretches, or one spec overwriting a
setting another reads fails a merge that changed nothing near it. And the
rules it checks — what Save sends, what a refused delete leaves selected —
are slow and indirect to reach through a page.

So behaviour moved into reducers tested in node, and the browser suite
shrank to what only a browser can show. AGENTS.md ("UI models", "UI
changes") holds the rules; this is how it was done and what moved.

## The tiers

| Tier                  | What it shows                                                          | Where                                                 | Gates a merge                         |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| Model tests           | What a screen does with each input and answer                          | `*.model.test.ts` beside the component                | yes (`checks`)                        |
| Route and store tests | What the server answers, stores and refuses                            | `app/api/**/route.test.ts`, `lib/**`, store scenarios | yes (`checks`, `data store`)          |
| Browser smoke         | The app renders, routes and keeps one path per area working end to end | `e2e/*.spec.ts`, tests tagged `@smoke`                | yes (`e2e (memory store)`)            |
| Full browser suite    | Everything else in `e2e/`: layout, screenshots, more paths end to end  | `e2e/*.spec.ts`                                       | no: advisory, on every PR and on main |

The cost difference is the point: the web app's `pnpm test` runs 6,400
tests in about 36 seconds (under 6 ms each); the browser suite spends about
2 seconds of a busy worker per test, hundreds of times as much, and is the
only tier that flakes.

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

## What moved

Five waves, each a set of screens migrated in parallel and gated by the
full unit suite and the full browser suite before the next began, plus a
track of specs that were really server tests.

| Wave                  | Screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Specs shrunk or removed                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: preview cards      | `act-preview`, `issue-preview` (Jira and JSM), `email-compose`, `directory-action-preview`, `chips`; the chat's card host `widget-card`; `mockup-viewer`, `mockup-card`                                                                                                                                                                                                                                                                                                                                                   | `act-preview`, `jsm-create-request-card`, `email-card-discard`, `schedule-card`, `directory-action-preview`, `widget-card`, `widget-card-resolve`, `mockups`                                                                                                                                                                                                                                                               |
| 2: the chat           | `composer`, `composer-tools-menu`, `draft-sync`, `chat-thread` (its send path), `message-list`, `chat-title`, `tool-permissions-form`, `voice-mode`, `voice-picker`, `voice-menu`, both voice forms, `global-shortcuts`, `omni-search`                                                                                                                                                                                                                                                                                    | `mass-upload`, `chat-compaction`, `composer-tools-menu`, `chat-draft`, `chat-temporary`, `chat-copy`, `host-tool-cards`, `chat-subagent`, `code-subagent`, `chat-title`, `chat-permission`, `voice`, `voice-barge-in`, `voice-pickers`, `global-shortcuts`, `omni-deep-search`                                                                                                                                             |
| 3: admin forms        | `model-forms` (the model roster), `salesforce-form`, the Salesforce change actions, `app-registration-form` (Atlassian and Entra), `audience-control`, the AD Manager and file share forms, `image-rule-forms`, `settings-form`, size requests, `chat-archive-form`, Outlook indexing, the Microsoft connect body and product card                                                                                                                                                                                        | `llm-models` (8 tests to 2), `salesforce`, `salesforce-admin`, `jira-admin`, `entra-developer`, `connector-audience-hint`, `admanager`, `file-shares`, `code-services`, `organization-name`, `sandbox-size-requests`, `chat-archive`, `outlook-indexing`, `microsoft-teams-onenote`; removed `phi-covered-model`, `sandbox-settings`, `agent-approval-policy`                                                              |
| 4: lists and builders | the artifacts library (six models), `notifications-list`, `preferences-form`, `cards`, `approval-actions`, `agent-builder`, `tool-picker`, `question-actions`, `run-timeline`, the coach marks provider and overlay, `image-card`, `image-model-form`, `context-meter`, `svg-save-buttons`, the code screens (`repo-tree`, `add-files-modal`, `upload-queue`, `branch-switcher`, `commit-dialog`, `new-code-project`, `pipelines-page`, `pr-subscribe`, `services-page`, `commits-page`, `pulls-page`, project templates) | `artifacts` (12 tests to 8), `code-project-artifacts`, `notifications`, `chat-notifications`, `actionable-cards`, `agent-instructions`, `coach-marks`, `coach-marks-off`, `image-generation`, `svg-save`, `chat-context-meter`, `code-file-management`, `code-uploads`, `branch-switcher`, `project-templates`, `code`, `code-pipelines`, `pr-subscriptions`, `project-pulls-commits`, `issue-cards`, `code-services-page` |
| Server answers        | the Jira Administration change actions (a model); route, action and lib tests for the rest                                                                                                                                                                                                                                                                                                                                                                                                                                | `jira-admin-changes`, `-fields`, `-spaces`, `-work-types`, `-automation`, `admin-change-queue`, `my-usage`, `activity-logs`, `code-concurrent-chats`, `access-revoke-sessions`, `oauth-consent`, `about-changelog-dates`; removed `security-headers`                                                                                                                                                                       |
| 5: the rest           | the Connectors page (`connectors-page`, `scope-connect-panel`, `scope-picker`, `disconnect-control`), the encryption key (`key-guard`, `encryption-key-section`, `shred-key-button`), `tools-dialog`, the chat list (`chat-nav`), `usage-viewer`, `mcp-servers-list`; route tests for MCP servers and the project download                                                                                                                                                                                                | `connectors`, `keys`, `project-tools-popover`, `nav-return-refresh`, `mcp-servers` (3 tests to 2), `code-downloads`, and the last two `waitForTimeout`s in `screenshots`                                                                                                                                                                                                                                                   |

In numbers, from the start to the end of wave 5:

- 88 models with about 1,660 model tests, and new route tests beside the
  routes the specs had been reaching through pages; the web app's unit
  suite went from 4,400 to 6,600 tests and still runs in under 40 seconds.
- The browser suite went from 343 tests to 287, and its specs lost about
  3,900 lines. Gone with them: every `waitForTimeout`, the retry loops in
  `global-shortcuts`, `agent-instructions`, `admanager` and
  `coach-marks-off`, most `pointerReaches`, and three specs that flipped
  an organization-wide switch other specs read.
- Moving the rules found ten bugs nobody had reported, each fixed with a
  test and a changelog entry: an event's end time read in the viewer's
  time zone; Fit to width returning to a stale scroll spot; files chosen
  during the mass-upload question uploading at once; a deleted knowledge
  note staying selected; the commit dialog re-ticking unticked files; a
  branch switch failing silently; a refused pull request subscription
  looking saved; a refused notification delete looking done; a partly
  failed artifact delete retrying files already gone; Connect with every
  capability unticked asking for all of them.

What a spec gave up is in its header: each says which model or route test
now owns its rules, and the wave commits list the browser coverage that
went (a mockup pan drag, a discarded card's receipt across a redraw, the
Jira and Outlook argument cards on the real server, and the like).

## Where it stands

Fifteen browser tests tagged `@smoke` and the page crawl gate a merge
(`pnpm --filter renkei e2e:smoke`, about a minute and a half); the full
suite runs beside them as advisory signal. A screen not listed above
still has its rules inline: it gets its model the next time those rules
change (AGENTS.md, "When you change a screen"). What is left in the
browser suite is the smoke paths, layout and visual checks
(`nav-shell`, `nav-chat-scroll`, `code-mobile`, `code-chat-width`,
`artifact-inline`, `about-sticky-footer`, `preferences-widths`,
`connector-logos`, `chat-row-menu-flip`, `voice-webkit`, the screenshot
gallery) and one press-through per migrated screen.

About fifteen specs still hold one `toPass` each, nearly all a press that
can land before the page hydrates. A page that says when its handlers are
attached (as `global-shortcuts` does with `data-shortcuts` on the root)
lets a spec wait once instead; that is the next step for the suite, not a
model's.

## Decisions to revisit

- **The full suite on pull requests.** It was kept on every pull request
  as advisory signal while the waves ran. With them done, it can move to
  main and a nightly run, which saves three shards' minutes on every pull
  request; the smoke tier and the unit suite stay the gate either way.

- **Branch protection** must require `checks` and `e2e (memory store)`
  (now the smoke tier) and not the `e2e shard i/3` jobs, or the full
  suite is still a gate.
- **Component tests with a DOM** (jsdom and Testing Library) are not
  adopted: a model test covers the rules without one, and what a model
  cannot show is mostly what jsdom cannot either (layout, real focus,
  frames). Revisit if wiring bugs between component and model start
  slipping past the smoke tier.
