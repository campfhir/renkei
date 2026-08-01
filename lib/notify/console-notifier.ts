/**
 * The delivery channel a deployment has before it configures one: a row in
 * `notifications`, rendered in the platform console.
 *
 * Calling it a channel rather than a placeholder is deliberate. It has a real
 * recipient, a real record of what was sent and when, and a real failure mode — so
 * the `Notifier` contract is exercised by the code that ships rather than waiting
 * for SMTP to make it true. When `SmtpNotifier` arrives it writes the same row and
 * then attempts the send, which is why `DeliveryResult` distinguishes "recorded and
 * delivered" from "recorded and not".
 */

import type { PlatformStore } from '../gateway/platform-store.js';
import type { DeliveryResult, Notification, NotificationChannel, Notifier } from './notifier.js';

export interface ConsoleNotifierOptions {
  store: PlatformStore;
  now: () => Date;
}

export class ConsoleNotifier implements Notifier {
  readonly channels: readonly NotificationChannel[] = ['console'];

  readonly #store: PlatformStore;
  readonly #now: () => Date;

  constructor(options: ConsoleNotifierOptions) {
    this.#store = options.store;
    this.#now = options.now;
  }

  async send(notification: Notification): Promise<DeliveryResult> {
    const at = this.#now().toISOString();

    try {
      const record = await this.#store.createNotification({
        channel: 'console',
        recipient: notification.recipient,
        subject: notification.subject,
        body: notification.body,
        tenantId: notification.tenantId,
        // Rendering it in the console *is* the delivery, so it is delivered the
        // moment the row exists. A channel that leaves the process would stamp
        // this only after the far end accepted it.
        deliveredAt: at,
        failedAt: null,
        failureReason: null,
      });

      return { delivered: true, id: record.id, at };
    } catch (error) {
      // Swallowed into a result rather than rethrown: the token this message
      // carries has already been minted, and a caller that treated an unwritable
      // log as a failure to issue would leave a live capability nobody was told
      // about. The caller shows the link and reports the delivery separately.
      return {
        delivered: false,
        id: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
