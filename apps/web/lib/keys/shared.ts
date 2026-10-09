/**
 * What the key status looks like on both sides of the wire
 * (docs/delegate-key-design.md): the shape GET /api/tenant/[tenantId]/keys
 * serves and the KeyGuard and the preferences section read, plus the
 * automation-window choices. Nothing server-only is imported here, so a
 * client component can import this file without dragging the database
 * driver into the browser bundle.
 */

/** The automation window a person may choose, in days; the default is the most (decision 4). */
export const AUTOMATION_WINDOW_DAYS = [7, 14, 30] as const;
export const AUTOMATION_WINDOW_DEFAULT_DAYS = 30;

export interface KeyStatusView {
  enrolled: boolean;
  /** A key row from before held keys: the browser enrolls on this sign-in. */
  legacy: boolean;
  /** That older row is passphrase-derived: enrollment needs the passphrase to move its rows. */
  legacyNeedsPassphrase: boolean;
  publicKey: string | null;
  wrappedPrivateKey: string | null;
  wrappedAutomationKey: string | null;
  version: number;
  enrolledAt: string | null;
  /** The live delegate instances and their public keys: what to seal to. */
  instances: { id: string; publicKey: string }[];
  /** Every live instance holds this session's delegation: nothing to do. */
  sessionDelegated: boolean;
  /** Some live instance lacks this session's delegation (a restart, a new instance): seal again. */
  instancesMissingSession: string[];
  /** Live instances holding the person's automation delegation, and until when. */
  automationInstances: string[];
  automationUntil: string | null;
  /** The window the person chose for their agents, in days. */
  automationDays: number;
  /** Devices asking for the key, for an enrolled device to approve. */
  pendingDevices: { id: string; code: string; createdAt: string }[];
  /** The delegate could not be reached; the browser retries. */
  unavailable: boolean;
}
