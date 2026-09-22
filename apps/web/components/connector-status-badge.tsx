/**
 * The "Connected" / "Not connected" pill every connector card shows next to
 * its heading. Pure presentation over a server-known boolean — no client
 * needed, so cards that render nothing else interactive can stay server
 * components entirely.
 */
export default function ConnectorStatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
      Connected
    </span>
  ) : (
    <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
      Not connected
    </span>
  );
}
