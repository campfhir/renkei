/**
 * A pull request's subscribe row (pr-subscribe.tsx): the person's own
 * opt-in as last read or saved, the change in flight, and the recorded
 * pipeline outcome.
 *
 * The component reads and writes …/pr-subscriptions and dispatches what
 * happened; what each box may do — Fix and Merge only while subscribed,
 * unsubscribing clearing both, what a change sends, what a refusal leaves
 * on screen, which outcome line shows — is here, and tested in
 * pr-subscribe.model.test.ts.
 */

export interface SubscriptionView {
  watchPipelines: boolean;
  autoFix: boolean;
  autoMerge: boolean;
}

export interface EventView {
  conclusion: string;
  actionTaken: string | null;
  observedAt: string;
}

export const NONE: SubscriptionView = { watchPipelines: false, autoFix: false, autoMerge: false };

export interface PrSubscribeState {
  /** null until the first read answers: the row renders nothing before then. */
  subscription: SubscriptionView | null;
  /** What was saved last, to go back to when a change is refused. */
  saved: SubscriptionView | null;
  lastEvent: EventView | null;
  busy: boolean;
  error: string | null;
}

export const initialPrSubscribe: PrSubscribeState = {
  subscription: null,
  saved: null,
  lastEvent: null,
  busy: false,
  error: null,
};

export type Box = 'watch' | 'fix' | 'merge';

export type PrSubscribeAction =
  | { type: 'loaded'; subscription: SubscriptionView | null; lastEvent: EventView | null }
  /** A box was pressed: the row shows the change at once, and it goes out. */
  | { type: 'toggled'; box: Box; checked: boolean }
  | { type: 'saved' }
  | { type: 'failed'; error: string };

/** The opt-in after a press: unsubscribing takes Fix and Merge off too. */
export function toggledSubscription(
  current: SubscriptionView,
  box: Box,
  checked: boolean
): SubscriptionView {
  if (box === 'fix') return { ...current, autoFix: checked };
  if (box === 'merge') return { ...current, autoMerge: checked };
  return {
    ...current,
    watchPipelines: checked,
    ...(checked ? {} : { autoFix: false, autoMerge: false }),
  };
}

export function prSubscribeReducer(
  state: PrSubscribeState,
  action: PrSubscribeAction
): PrSubscribeState {
  switch (action.type) {
    case 'loaded': {
      const subscription = action.subscription ?? NONE;
      return { ...state, subscription, saved: subscription, lastEvent: action.lastEvent };
    }
    case 'toggled':
      if (!state.subscription) return state;
      return {
        ...state,
        subscription: toggledSubscription(state.subscription, action.box, action.checked),
        busy: true,
        error: null,
      };
    case 'saved':
      return {
        ...state,
        busy: false,
        saved: state.subscription,
        // An unsubscribed PR's old outcome is not this subscription's.
        lastEvent: state.subscription?.watchPipelines ? state.lastEvent : null,
      };
    case 'failed':
      // The boxes go back to what is actually saved.
      return { ...state, busy: false, error: action.error, subscription: state.saved };
  }
}

/** What a change sends: a POST of the whole opt-in while subscribed, a DELETE when not. */
export function saveRequest(
  prNumber: number,
  next: SubscriptionView
):
  | { method: 'POST'; body: { prNumber: number } & SubscriptionView }
  | { method: 'DELETE'; body: { prNumber: number } } {
  return next.watchPipelines
    ? {
        method: 'POST',
        body: {
          prNumber,
          watchPipelines: next.watchPipelines,
          autoFix: next.autoFix,
          autoMerge: next.autoMerge,
        },
      }
    : { method: 'DELETE', body: { prNumber } };
}

/** Whether a box can be pressed: Subscribe while nothing is in flight, Fix and Merge only while subscribed. */
export function boxEnabled(state: PrSubscribeState, box: Box): boolean {
  if (state.busy || !state.subscription) return false;
  return box === 'watch' || state.subscription.watchPipelines;
}

/** The plan's own copy for each (conclusion, action taken) pair it names. */
export function outcomeLine(event: EventView): string {
  if (event.conclusion === 'success') {
    if (event.actionTaken === 'merged') return 'Pipeline succeeded — merged automatically.';
    if (event.actionTaken === 'merge_failed')
      return 'Pipeline succeeded, but the automatic merge failed.';
    return 'Pipeline succeeded.';
  }
  if (event.conclusion === 'failure') {
    if (event.actionTaken === 'fix_started')
      return 'Pipeline failed — a fix attempt was started in this chat.';
    if (event.actionTaken === 'fix_failed')
      return 'Pipeline failed, and the chat note could not be posted.';
    return 'Pipeline failed.';
  }
  if (event.conclusion === 'running') return 'Pipeline is running.';
  if (event.conclusion === 'pending') return 'Pipeline is pending.';
  return 'Pipeline outcome unclear.';
}

/** The outcome line the row shows: only while subscribed, and only once one is recorded. */
export function shownOutcome(state: PrSubscribeState): string | null {
  return state.subscription?.watchPipelines && state.lastEvent
    ? outcomeLine(state.lastEvent)
    : null;
}
