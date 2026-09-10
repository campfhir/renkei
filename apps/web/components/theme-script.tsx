/**
 * Sets `<html data-theme>` before the shell below it ever paints.
 *
 * A plain effect in a client component would run AFTER first paint — the
 * page would flash light, then flip to dark a frame later, every load. This
 * has to be an inline, synchronous script rendered as the very first thing
 * `[slug]/layout.tsx` returns (so it's the first content in <body>, and
 * nothing visible has been painted ahead of it) instead of a React
 * component's effect. It duplicates the key format and resolution logic in
 * `lib/theme.ts` rather than importing it — an inline script can't import a
 * module, and this one is deliberately as small as it can be.
 *
 * Reads localStorage only: it runs before hydration, before this layout's
 * server-fetched preference can reach the browser in any other way.
 * theme-sync.tsx corrects a stale or absent local cache against that
 * preference right after hydration; the one-frame gap only shows up the
 * first time a person's preference reaches a browser that's never seen it.
 */
export default function ThemeScript({ tenantId }: { tenantId: string }) {
  const script = `(function(){try{var k="renkei:theme:${tenantId}";var m=localStorage.getItem(k);if(m!=="light"&&m!=="dark"&&m!=="auto")m="auto";var resolved=m==="auto"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;document.documentElement.setAttribute("data-theme",resolved);}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
