/**
 * Whether a registered element takes up space somewhere a person could
 * see it. The menu registers its anchors twice — once from the drawer,
 * once from the column — and only one of the two is ever on screen: the
 * column is `display: none` below `lg`, the drawer parks itself at
 * `left: -100%` above it. This is geometry, not a DOM query: the element
 * is already known, the question is only where it is.
 */
export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.right <= 0 || rect.bottom <= 0) return false;
  if (rect.left >= window.innerWidth) return false;
  return true;
}
