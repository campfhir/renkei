/**
 * What a widget's `ui/open-link` may hand to the browser. The URL is the
 * widget's to choose, and a widget renders provider-sourced text, so a
 * scheme the OS would dispatch to another app is not opened on a click.
 */
const OPENABLE_PROTOCOLS = new Set(['https:', 'mailto:', 'webexteams:']);

/** The URL as the browser would resolve it when its scheme is allowed, null otherwise. */
export function openableWidgetLink(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}
