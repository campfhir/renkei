# Per-item failure handling in loops, and visible retry budgets — design

No code yet.

Two things, related by the same confusion: **what "retry" means depends on
which node you are looking at**, and the vocabulary for "what should failure
do" stops at the step boundary.

## What exists today

Three different budgets, all spelled `maxAttempts`, none of them about tool
calls:

| Node              | `maxAttempts` retries…                                   | Scope                       | Editable in the UI? |
| ----------------- | -------------------------------------------------------- | --------------------------- | ------------------- |
| `ActionStep`      | the step's own work — one model call plus its tool calls | per step, **per iteration** | yes (failure panel) |
| `BranchStep`      | the routing decision, "which path?"                      | per branch, per iteration   | **no**              |
| `UntilLoopStep`   | the stop-condition decision, "are we done?"              | per loop, per iteration     | **no**              |
| `ForEachLoopStep` | — the field does not exist                               | —                           | n/a                 |

`ForEachLoopStep` (`packages/agents/src/steps.ts:246`) has no `maxAttempts`
at all, and `normalizeNode`'s foreach arm (`validate.ts:812`) returns without
one. A foreach loop's only retrying happens inside its body steps. That is
correct and stays — nothing here adds one.

`maxIterations` is a separate field, and its purpose is narrow: **a runaway
guard.** It exists so an agent handed a list of 40,000 tickets does not try
to process 40,000 tickets. It is not a business rule about how much work is
worth doing, and the UI should not invite anyone to tune it as one.

Its semantics are mode-dependent:

- **foreach** — items past the limit are skipped with a logged warning
  (`engine.ts:1069`).
- **until** — reaching it with the condition unmet **fails the run**
  (`steps.ts:285`: "a tripwire for a premise that never came true").

Nothing in the builder says the second one.

### A tool call is not a retryable unit

Worth stating plainly because it is the question that started this. When a
tool call fails, the model receives the failure as a tool result and
continues **within the same attempt**, spending more of its tool budget. No
retry has happened. The attempt ends only when the model calls `finish_step`
and declares an outcome, and it is that declaration — never the HTTP failure
— that `failureHandling` routes.

The step is the retry unit. There is no per-call retry and none is proposed:
a tool that failed for a reason the model can read is better served by the
model choosing differently than by blind repetition.

## Problem 1 — failure vocabulary stops at the step

`executeStep` returns `{kind: 'fail'}` when a failure lands on `exit`
handling or exhausts its retries (`engine.ts:1790`). The driver's response is
unconditional:

```ts
await finalizeRun(run, 'failed', result.errorKind, result.error, vars);
return; // engine.ts:1232
```

No loop-aware branch. The frame stack is abandoned mid-iteration, so **item 4
of 50 failing means items 5–50 never run**.

Today's four actions (`steps.ts:137`) can express "end the run", "try again",
"move to the next step", and "this is not an error, stop" — but nothing about
the _container_ a step happens to be sitting in.

### Proposal: the step says what it breaks, the container says what that means

Two additions to `FailureHandling.action`:

```ts
action:
  | 'retry'          // existing
  | 'continue'       // existing — next step, same iteration
  | 'stop-quiet'     // existing
  | 'exit'           // existing — fail the RUN
  | 'next-iteration' // NEW — abandon the rest of this round, run the next item
  | 'break'          // NEW — fail the enclosing loop or branch
```

`next-iteration` is the common case and needs no container cooperation: this
item is a write-off, the remaining body steps would only operate on a broken
item, go get the next one.

`break` is the escalation. It ends the enclosing container — and then the
**container** decides what that means, with its own declaration:

```ts
interface ForEachLoopStep {
  // …
  /**
   * What a `break` from a body step does to the run.
   *   'exit'       — fail the run (default: it is what every existing agent
   *                  already does, and failure semantics must not change
   *                  silently on a save)
   *   'continue'   — end the loop, carry on after it
   *   'stop-quiet' — end the run gracefully as 'stopped'
   */
  onBreak?: 'exit' | 'continue' | 'stop-quiet';
}
```

`BranchStep` and `UntilLoopStep` take the same field. A `break` inside a
branch path inside a loop hits the **innermost** container first; if that
container's `onBreak` is `'exit'`, the failure keeps propagating outward and
the next container decides in turn. That composition is the point: it is the
same grammar at every level, so "what happens when this fails" is answerable
by reading one node at a time.

Both new actions are meaningless outside a container. The validator should
reject `next-iteration` on a step with no enclosing loop, and `break` on a
step with no enclosing loop or branch — a save-time error, not a runtime
surprise.

This supersedes the `onItemFailure` enum in the first draft of this document.
That put the policy on the loop, which cannot express "this particular
failure code skips the item, that one kills the loop". The step already
routes per outcome code; the disposition belongs there.

### Bounding the damage

`next-iteration` needs a ceiling or a list of 50 broken items costs 50 model
calls to conclude what the third failure implied:

```ts
/** Give up after this many items have failed. Absent means no bound. */
maxItemFailures?: number;
/** Binds the list of items that failed and why, for a later step to report. */
failuresVar?: string;
```

Hitting `maxItemFailures` fails the run — it is a different event from
skipping a few, and the one that deserves a notification.

### Engine changes

The driver's failure arm becomes container-aware:

```ts
const enclosing = innermostContainerFrame(stack);
switch (
  disposition // from the matched handling
) {
  case 'next-iteration':
    recordItemFailure(enclosing, result);
    if (overFailureBound(enclosing)) {
      /* fail the run */
    }
    popToBodyEnd(enclosing); // discard EVERY frame above it
    continue;
  case 'break':
    return applyOnBreak(enclosing, result); // may propagate outward
}
```

Three places the bugs will be:

1. **Frame unwinding.** A step can fail from inside a branch path inside a
   group inside the loop. `popToBodyEnd` must discard every frame above the
   loop frame, not one.
2. **`collectVar` on a skipped round.** A skipped round contributes nothing;
   the code already tolerates a round saving nothing (`steps.ts:262`), so this
   wants a test, not new code.
3. **The attempt row stays `failed`.** The timeline keeps its red pill —
   "skipped" is what happened to the _item_, not to the step.

### Run status when items were skipped

`succeeded`, with `failuresVar` bound. Not a new status: `finalizeRun`'s
status feeds notifications, chaining and the admin oversight counts, and a
fourth value ripples through all three to say something the digest can state
in words. A run that processed 47 of 50 items did succeed at what it was
asked; the three failures are content.

## Problem 2 — retries default to 5 for a step that never retries

`newStep` sets `maxAttempts: Math.min(5, attemptsCap)`
(`flow-tree.ts:38`), so every new step claims five tries. Those tries are
unreachable unless a failure condition routes to `retry`, so the number is
usually fiction — and where it is not, it is a number nobody chose.

**A step should default to no retries.** `maxAttempts: 1` on creation; the
tries field appears when the author adds a retrying condition, which is the
moment they have an opinion. `BRANCH_DEFAULT_ATTEMPTS` and
`LOOP_DEFAULT_ATTEMPTS` (both 2, `steps.ts:443`/`:445`) stay as they are:
those decisions are the engine re-asking a model a yes/no question it
fumbled, not the author's work being repeated.

This is a default change, not a migration — existing agents keep their stored
values.

## Problem 3 — the numbers are invisible, and the two that exist are named alike

`BranchStep.maxAttempts` and `UntilLoopStep.maxAttempts` are enforced
(`engine.ts:2289`, `:2579`) and unreachable from the builder: `branch-editor`
has no numeric control, `loop-editor` sets `LOOP_DEFAULT_ATTEMPTS` at line 69
and never renders it.

Meanwhile the node cards conflate the two concepts. `loop-node.tsx:72` renders
`maxIterations` as **"up to 10×"**; `step-node.tsx:90` renders `maxAttempts`
as **"↻ up to 3×"**. Same shape, unrelated meanings.

### Chips on the node cards

Render both as chips, in the same visual family as the existing
`saves "activity"` / `thinks` chips, with the words spelled out — the `×`
suffix is what made them look interchangeable:

| Chip                    | Node                     | Reads             |
| ----------------------- | ------------------------ | ----------------- |
| `↻ up to 10 iterations` | loop                     | the runaway guard |
| `up to 2 retries`       | step, branch, until-loop | the retry budget  |

"Iterations" over "rounds": it is the word the type, the engine and the run
timeline already use (`LoopFrame.iteration`, the `Iteration 2` header in
`run-timeline.tsx:255`), and inventing a second word for it in one surface
was the mistake.

A step with no retries shows no retry chip at all — which, with the default
change above, is most of them. Absence of a chip is the honest rendering of
"this runs once".

### Editors

**Branch** — beside the existing failure-route control:

```
If the decision fails, try again  × [2] times  then  take the failure route
```

**Loop, `until` mode only** — beside the condition. In foreach mode, one line
under the mode switch instead: _"Each step inside sets its own tries."_

**Until-mode `maxIterations` hint** — the builder currently documents only the
foreach behaviour. Add:

> Reaching this limit with the condition still unmet fails the run.

Both reuse `useNumericInput` and the `attemptsCap` the step editor already
takes.

## Order

Problem 2 is a one-line default change plus tests. Problem 3 is a few hours
and reuses the tries field. Problem 1 is the one with real design risk, in
the frame unwinding, and the one worth building — it decides whether an agent
can be trusted with a fifty-item list unattended.

Build 1 first. Surfacing a branch's retry budget invites tuning a number that
will not save a loop from one bad item.
