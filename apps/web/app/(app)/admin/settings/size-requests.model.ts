/**
 * The admin's "Checkout size requests" list on Settings (size-requests.tsx):
 * which requests wait and which were recently decided, what one row's
 * Approve and Deny send, and what a refusal leaves on the row. The
 * component makes the POST and refreshes the page; this is tested in
 * size-requests.model.test.ts. The server's side (only a pending request
 * is decided, an approval within 1–64 GB) is route tests beside
 * app/api/admin/sandbox-size-requests/[id].
 */

export const GB = 1_073_741_824;

/** A byte count as the list says it: "24 GB", "1.5 GB". */
export function gbText(bytes: number): string {
  const n = bytes / GB;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;
}

export interface ListedRequest {
  id: string;
  projectName: string;
  requestedBytes: number;
  status: 'pending' | 'approved' | 'denied';
  decisionNote: string | null;
}

/** The waiting requests, and the ten most recently decided (the server lists pending first, then newest). */
export function partitionRequests<T extends ListedRequest>(
  requests: T[]
): { pending: T[]; decided: T[] } {
  return {
    pending: requests.filter((request) => request.status === 'pending'),
    decided: requests.filter((request) => request.status !== 'pending').slice(0, 10),
  };
}

/** One decided request, as its line says it: "Monorepo — 20 GB approved (note)". */
export function decidedLine(request: ListedRequest): string {
  return `${request.projectName} — ${gbText(request.requestedBytes)} ${request.status}${
    request.decisionNote ? ` (${request.decisionNote})` : ''
  }`;
}

export interface RowState {
  /** "Approve up to (GB)": what was asked, until the admin changes it. */
  approveGb: number;
  note: string;
  busy: boolean;
  error: string | null;
}

export type RowAction =
  | { type: 'approveGbChanged'; gb: number }
  | { type: 'noteChanged'; note: string }
  | { type: 'sent' }
  | { type: 'decided' }
  | { type: 'failed'; error: string };

export function initRow(requestedBytes: number): RowState {
  return { approveGb: Math.round(requestedBytes / GB), note: '', busy: false, error: null };
}

export function rowReducer(state: RowState, action: RowAction): RowState {
  switch (action.type) {
    case 'approveGbChanged':
      return { ...state, approveGb: action.gb };
    case 'noteChanged':
      return { ...state, note: action.note };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'decided':
      return { ...state, busy: false };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

export type DecisionBody =
  | { decision: 'approved'; note: string; approvedBytes: number }
  | { decision: 'denied'; note: string };

/** What Approve or Deny sends: an approval carries the size, a denial only the note. */
export function decisionBody(state: RowState, decision: 'approved' | 'denied'): DecisionBody {
  return decision === 'approved'
    ? { decision, note: state.note, approvedBytes: state.approveGb * GB }
    : { decision, note: state.note };
}
