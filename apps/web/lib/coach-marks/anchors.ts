/**
 * The contract between a tour and the markup it points at.
 *
 * A step names an anchor; an element carries it as `data-coach="<anchor>"`
 * (through `coachAnchor()`, so a typo is a type error). The list is closed
 * on purpose: `tours.test.ts` checks every step's target against it, so
 * renaming or removing an anchor breaks at unit-test time rather than as a
 * step that quietly stops pointing at anything. Add an anchor here first,
 * then to the element, then to a tour.
 *
 * Names say where the element lives (`nav-`, `chat-`…) and what it is,
 * never how it looks — a button that becomes a link keeps its anchor.
 */
export const COACH_ANCHORS = [
  /** The hamburger in the top bar. */
  'nav-menu-button',
  /** The Workspace group in the menu column. */
  'nav-workspace',
  /** The Chat group in the menu column. */
  'nav-chat',
  /** The avatar button that opens the account menu. */
  'nav-account',
  /** The Tutorials item inside the account menu. */
  'account-tutorials',
  /** The actionable-items heading block on the home page. */
  'home-feed',
  /** The New agent button on the Agents page. */
  'agents-new',
  /** The Import button beside it. */
  'agents-import',
  /** The list of agents. */
  'agents-list',
  /** The chat's message box. */
  'chat-composer',
  /** The Tools button in the composer. */
  'chat-tools',
  /** The model picker in the composer. */
  'chat-model',
  /** The Send button. */
  'chat-send',
  /** The Add connector button on the Connectors page. */
  'connectors-add',
  /** The MCP endpoint block on the Connectors page. */
  'connectors-endpoint',
  /** The Organization page's grid of console areas. */
  'admin-sections',
] as const;

export type CoachAnchor = (typeof COACH_ANCHORS)[number];

export function isCoachAnchor(value: unknown): value is CoachAnchor {
  return typeof value === 'string' && COACH_ANCHORS.some((anchor) => anchor === value);
}

/** The attribute an element spreads to become a step's target. */
export function coachAnchor(name: CoachAnchor): { 'data-coach': CoachAnchor } {
  return { 'data-coach': name };
}

/** The selector the engine looks the anchor up with. */
export function coachSelector(name: CoachAnchor): string {
  return `[data-coach="${name}"]`;
}
