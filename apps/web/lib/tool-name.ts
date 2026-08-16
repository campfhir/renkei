/**
 * Tool names for people rather than for the wire.
 *
 * `confluence_update_blogpost` is an identifier; nobody outside this codebase
 * should have to read one to find out how much they use the product. Every
 * tool already carries a written title — `'Confluence · Read — Edit a blog
 * post'` — so the readable name exists; it just needs the parts that are
 * already said elsewhere taken off.
 *
 * The connector prefix goes because the cards are grouped under a connector
 * heading, and repeating "Confluence" on eleven cards under a heading that
 * says Confluence is noise. The Read/Act marker goes for the same reason: it
 * is shown as a badge where it matters.
 */

/** `'Confluence · Read — Edit a blog post'` → `'Edit a blog post'`. */
function fromTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  // Only the em and en dash the titles actually use, and only surrounded by
  // space. A plain hyphen would split "Re-index knowledge" into "index
  // knowledge" — a wrong name is worse than an unprettified one.
  const match = /\s[—–]\s*(.+)$/.exec(trimmed);
  const tail = match?.[1]?.trim();
  if (tail && tail.length > 0) return tail;
  // A title with no separator is still human-written prose; showing it beats
  // falling back to the identifier.
  return trimmed;
}

/**
 * `'confluence_update_blogpost'` → `'Update blogpost'`.
 *
 * The fallback, used for a tool this build has no catalog entry for — one an
 * operator sees because a colleague called it and their connectors differ.
 * Ugly is acceptable here; wrong is not, so it does no cleverer guessing than
 * dropping the namespace and unpicking the underscores.
 */
function fromName(name: string): string {
  const underscore = name.indexOf('_');
  const tail = underscore > 0 ? name.slice(underscore + 1) : name;
  const words = tail.replace(/_/g, ' ').trim();
  if (words.length === 0) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function friendlyToolName(name: string, title: string | null): string {
  return (title ? fromTitle(title) : null) ?? fromName(name);
}
