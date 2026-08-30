'use client';

import ToastStack from '@/components/toast-stack';
import NotificationPermissionNudge from '@/components/notification-permission-nudge';

/**
 * The one fixed-position box anchoring everything that lives in a page
 * corner: arrival toasts and the "finish turning on notifications" nudge,
 * stacked in a single column instead of two independently `fixed` boxes
 * that would otherwise land on top of each other.
 *
 * `flex-col-reverse` with the nudge listed FIRST puts it at the bottom of
 * the column — closest to the screen edge, under whatever arrival toasts
 * are currently showing above it. That is deliberate: the nudge is a
 * standing action item, not a thing that just happened, and it should read
 * as the quieter, more permanent element of the two.
 *
 * `z-30` against the nav: the drawer is z-50 and its menu is z-40, so
 * nothing in this corner can ever cover the menu somebody just opened to
 * get away from it.
 */
export default function NotificationCorner({
  tenantId,
  corner,
  toastsEnabled,
}: {
  tenantId: string;
  corner: 'bottom-left' | 'bottom-right';
  toastsEnabled: boolean;
}) {
  return (
    <div
      className={`fixed bottom-4 z-30 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2 ${
        corner === 'bottom-left' ? 'left-4' : 'right-4'
      }`}
    >
      <NotificationPermissionNudge tenantId={tenantId} />
      {toastsEnabled ? <ToastStack /> : null}
    </div>
  );
}
