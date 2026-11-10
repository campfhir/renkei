/**
 * The checkout size limit on a code project's page and its "Ask for more
 * space" dialog (size-request.tsx): what the line under the project says
 * about the newest request, what the dialog starts with, when Send is
 * allowed, what it sends, and what a refusal or an accepted request leaves
 * on screen. The component makes the POST and refreshes the page; this is
 * tested in size-request.model.test.ts. The server's own rules (one open
 * ask per project, more than the current limit, at most 64 GB) are
 * route tests beside app/api/code/projects/[projectId]/size-request.
 */

export const GB = 1_073_741_824;
export const MAX_GB = 64;

/** A byte count as the page says it: "8 GB", "1.5 GB". */
export function gbText(bytes: number): string {
  const n = bytes / GB;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;
}

export interface SizeRequestSummary {
  status: 'pending' | 'approved' | 'denied';
  requestedBytes: number;
  decisionNote: string | null;
}

/**
 * What the project page says about its newest request: a waiting one
 * replaces the way to ask (one open ask per project); a decided one is
 * said, with the way to ask again beside it.
 */
export type RequestLine =
  { kind: 'none' } | { kind: 'pending'; text: string } | { kind: 'decided'; text: string };

export function requestLine(request: SizeRequestSummary | null): RequestLine {
  if (!request) return { kind: 'none' };
  if (request.status === 'pending') {
    return {
      kind: 'pending',
      text: `Your request for ${gbText(request.requestedBytes)} is waiting for an admin.`,
    };
  }
  if (request.status === 'approved') {
    return {
      kind: 'decided',
      text: `Your request for ${gbText(request.requestedBytes)} was approved.`,
    };
  }
  return {
    kind: 'decided',
    text: `Your last request was denied${request.decisionNote ? `: ${request.decisionNote}` : '.'}`,
  };
}

export interface SizeRequestState {
  open: boolean;
  /** The size wanted, in whole GB, as the field holds it. */
  wanted: number;
  reason: string;
  busy: boolean;
  error: string | null;
}

export type SizeRequestAction =
  | { type: 'opened' }
  | { type: 'closed' }
  | { type: 'wantedChanged'; gb: number }
  | { type: 'reasonChanged'; reason: string }
  | { type: 'sent' }
  | { type: 'accepted' }
  | { type: 'failed'; error: string };

/** The dialog starts at twice the current limit, never past the most that can be asked. */
export function initSizeRequest(limitBytes: number): SizeRequestState {
  return {
    open: false,
    wanted: Math.min(MAX_GB, Math.round(limitBytes / GB) * 2),
    reason: '',
    busy: false,
    error: null,
  };
}

export function sizeRequestReducer(
  state: SizeRequestState,
  action: SizeRequestAction
): SizeRequestState {
  switch (action.type) {
    case 'opened':
      return { ...state, open: true };
    case 'closed':
      return { ...state, open: false };
    case 'wantedChanged':
      return { ...state, wanted: action.gb };
    case 'reasonChanged':
      return { ...state, reason: action.reason };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'accepted':
      // The page refreshes to the waiting request; the reason is not kept for a next ask.
      return { ...state, busy: false, open: false, reason: '' };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Send needs a reason, and nothing in flight. */
export function canSend(state: SizeRequestState): boolean {
  return !state.busy && state.reason.trim().length > 0;
}

export function sendLabel(state: SizeRequestState): string {
  return state.busy ? 'Sending…' : 'Send request';
}

/** What Send posts: the size in bytes and the reason as typed (the server trims it). */
export function requestBody(state: SizeRequestState): { requestedBytes: number; reason: string } {
  return { requestedBytes: state.wanted * GB, reason: state.reason };
}

/** The dialog shows only while no request waits: a waiting one replaces the form. */
export function dialogShown(state: SizeRequestState, request: SizeRequestSummary | null): boolean {
  return state.open && request?.status !== 'pending';
}

/** The field's floor: one GB more than the current limit. */
export function minWantedGb(limitBytes: number): number {
  return Math.floor(limitBytes / GB) + 1;
}
