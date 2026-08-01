/**
 * Getting a message to a human, and the seam SMTP and SMS attach to.
 *
 * Exactly one thing needs this today — handing a tenant operator an onboarding
 * link — and the obvious shortcut would be to render the link and stop. The
 * interface exists instead because the choice of *how* a link reaches somebody is
 * a deployment's, not this code's: an air-gapped install copies it out of the
 * console, a hosted one emails it, and a regulated one may want an SMS second
 * factor on the same act. Deciding that later is cheap; retrofitting the seam
 * through the routes that compose the message is not.
 *
 * Three properties, each load-bearing:
 *
 *   - **`send` returns a failure rather than throwing.** By the time delivery is
 *     attempted the token already exists, so a dead SMTP server must not be
 *     reported as a failure to issue the link. The caller renders the link itself
 *     regardless — the same "show the secret once, to the browser that caused it"
 *     move the device-approval page makes — and reports delivery separately.
 *   - **`channels` is on the interface.** The console offers only what the
 *     deployment can actually deliver, the way it already asks whether a
 *     registration app is configured before offering registration. It is a list
 *     rather than a single value because the obvious next implementation fans out
 *     to more than one.
 *   - **The body is opaque to the notifier.** The route composes the text; a
 *     notifier moves it. That is what lets an `SmtpNotifier` be a drop-in rather
 *     than a second place where the message is written.
 */

/** Widened as implementations land. `console` means "rendered in the platform console". */
export type NotificationChannel = 'console';

export interface Notification {
  channel: NotificationChannel;
  /** An address, an E.164 number, or a label. Opaque here; meaningful to the channel. */
  recipient: string;
  subject: string;
  /** Plain text. May carry a one-time secret, which is why delivery is recorded. */
  body: string;
  /** Context for the reader of the delivery log. Null for a message with no tenant. */
  tenantId: string | null;
}

export type DeliveryResult =
  | { delivered: true; id: string; at: string }
  | { delivered: false; id: string | null; reason: string };

export interface Notifier {
  /** What this deployment can actually deliver. Empty means "nothing configured". */
  readonly channels: readonly NotificationChannel[];
  send(notification: Notification): Promise<DeliveryResult>;
}
