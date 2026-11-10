/**
 * Deep links into a page: a `#id` in the address names the element to bring
 * into view. `anchorId` builds those ids from a visible name, so a link and
 * the heading it points at are made by the same rule.
 */

export function anchorId(prefix: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${prefix}-${slug}`;
}

/**
 * How a scroll this page starts should move: smoothly, unless the person
 * asked for less motion (CSS's scroll-behavior cannot override a script's
 * explicit `behavior`).
 */
export function scrollMotion(): ScrollBehavior {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}

const MARK = ['ring-2', 'ring-blue-400', 'ring-offset-2', 'rounded-lg'];

/** Scrolls to the element the address names, and marks it for a moment. */
export function scrollToHash(): void {
  let id: string;
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return;
  }
  const named = id ? document.getElementById(id) : null;
  if (!named) return;
  // A heading names its section: the section is what is brought into view.
  const target = named.closest('section') ?? named;
  target.scrollIntoView({ block: 'start', behavior: scrollMotion() });
  target.classList.add(...MARK);
  window.setTimeout(() => target.classList.remove(...MARK), 2000);
}
