# Dragging nodes to rearrange them — design

No code yet. The MCP half of the same request (`agent_patch_steps`) is built;
this is the builder half.

## The good news

Almost all of it exists. `flow-tree.ts` already has the whole move
vocabulary, because the "Move to…" menu needed it:

| Piece                                | What it does                                         |
| ------------------------------------ | ---------------------------------------------------- |
| `InsertLocation`                     | `top` / `path(pathId)` / `body(containerId)` + index |
| `moveNodeTo(nodes, id, location)`    | the move, index clamped                              |
| `moveIsLegal(nodes, node, location)` | cycle guard, depth budgets, loop-in-loop             |
| `moveTargets(nodes, id)`             | every legal destination list                         |
| `issuesByNode(...)`                  | validation issues routed to the node that owns them  |

So this is a UI layer over solved logic, not new tree work. `moveNodeTo`
returns the ORIGINAL array when a move is refused, which is already how the
canvas distinguishes "nothing happened".

One gap: `moveTargets` returns end-of-list indices only, because a menu has
no notion of "between these two". Dragging does. `moveNodeTo` already accepts
any index, so nothing needs to change — the drop target just computes its own
index rather than taking one from `moveTargets`.

## Why this is worth building

People try it. It is the obvious gesture for a vertical list of cards, and
the current answer is a `↑`/`↓` pair for reordering within a list plus a
"Move to…" menu for crossing lists — two different mechanisms for one
intention, neither of which is what anyone reaches for first.

## Drop targets

The canvas already renders a `+` insertion affordance between every pair of
nodes. Those are exactly the drop points, which keeps the model honest: you
can drop wherever you could have inserted.

A drop target is `{ location: InsertLocation }`, derived from the gap it sits
in — top-level gaps give `topLocation(i)`, gaps inside a branch path give
`pathLocation(pathId, i)`, gaps inside a loop or group body give
`bodyLocation(containerId, i)`.

Every target is filtered through `moveIsLegal` **for the node being dragged**,
computed once on drag start. An illegal target is not merely inert — it must
not light up, or the drop reads as accepted and silently does nothing.

## The outline

The requirement is showing where the node will land, not just that a gap is
active. Two things move:

1. **The gap opens.** The targeted gap animates to the dragged node's height,
   so the surrounding nodes visibly displace — the layout shows the result
   before the drop, which is the whole point.
2. **A ghost outline** — a dashed border at the dragged node's size — fills
   that gap, carrying the node's name so a long list stays legible while the
   original is still in place.

The dragged node itself stays visible at reduced opacity rather than being
removed. Removing it makes the list jump on drag start, and the gap indices
shift under the cursor.

**Container edges need their own treatment.** A gap at the first or last
position inside a loop is visually adjacent to a gap just outside it, and
"inside the loop" versus "after the loop" is a real semantic difference — one
runs per item, the other runs once. The container's border should highlight
whenever the active target is inside it, so the answer is never ambiguous.

## Moving into containers, and the variable problem

This is the part with the actual design question. A step inside a loop can
reference the loop's `itemVar`; a step in a branch path can reference what
earlier steps in that path saved. Move it out and those chips become unbound.
Move a step INTO a loop and it may now run N times when its author meant once.

The validator already reports unbound variables — `validate.ts` builds its
known set from builtins, trigger names and `saveAs` names, and `issuesByNode`
routes each issue to the node that owns it. So a broken move is already
_detected_. What is missing is that it is detected **after** the drop, in a
list of issues, rather than at the moment the person is deciding.

Three options, and I would build the second:

1. **Refuse the move.** Wrong: it is sometimes exactly what someone means to
   do, as a first step before fixing the references. The builder does not
   otherwise stop you from making an invalid agent — it stops you _saving_
   one.
2. **Allow it and warn during the drag.** When the dragged subtree references
   a variable that would not be bound at the target location, the outline
   turns amber and names the first casualty: _"`the ticket` is not available
   here"_. The drop still works. This tells the truth at the moment of
   choosing, and leaves the choice.
3. **Allow it silently** and let the existing validation catch it. Cheapest,
   and the status quo for the "Move to…" menu — but it turns a deliberate
   action into a mystery error somewhere else on the page.

Option 2 needs one new pure function: given a node and a prospective
location, which of its var chips would be unbound there. That is a subset of
what the validator already computes; the work is running it against a
_hypothetical_ tree rather than the saved one. Cheapest honest implementation
is to apply `moveNodeTo` to a clone and run the existing validation, which at
the platform's ≤20-node cap is free.

## Keyboard and accessibility

Drag-and-drop cannot be the only way to do this. The `↑`/`↓` buttons and the
"Move to…" menu stay — they are the keyboard path, and dragging is an
addition rather than a replacement. The drag handle should be a button with
`aria-grabbed` semantics; a node being dragged should announce its target
list on change, since a sighted user gets that from the outline.

## Touch

The builder has a mobile layout, and the same users try the same gesture. HTML
drag-and-drop does not fire on touch, so this wants Pointer Events with a
long-press to initiate — otherwise dragging fights scrolling.

## What to build first

The outline and gap-opening against top-level reordering only, with
`moveIsLegal` filtering. That is the bulk of the interaction work and is
verifiable in one screenshot. Container drops and the amber
variable warning follow, in that order — containers are where the semantics
get interesting, and the warning is only worth building once dropping into a
loop is possible at all.
