/**
 * Which file in `public/connector-logos/` a connector's mark lives in.
 *
 * Split out of `connector-icon.tsx` so it can be tested: a mark that fails to
 * resolve degrades to a built-in glyph, silently and per-user, which is the
 * kind of breakage nobody reports and everybody sees. Renaming or removing an
 * SVG is a routine thing to do; noticing that a card quietly stopped showing
 * its logo is not.
 *
 * The filename and the capabilityKey are DIFFERENT NAMESPACES and conflating
 * them is a real hazard, not a tidiness question. `capabilityKey` is persisted
 * in org settings as `disabledConnectors` and gates tool registration, so
 * renaming a key to match a file re-enables that connector for every org that
 * had switched it off. Assets are cheap to rename; the key is not.
 */

/** Where a capability's mark is NOT named after the capability. */
export const LOGO_FILE: Record<string, string> = {
  // Confluence is provisioned as 'atlassian-confluence' — the suite prefix its
  // OAuth app carries — but its mark is the product logo, named for the
  // product.
  'atlassian-confluence': 'confluence',
  // Bitbucket: same suite-prefix key, same product-named mark.
  'atlassian-bitbucket': 'bitbucket',
};

/**
 * Marks requested by an explicit `logo` prop rather than by any capability
 * key, listed so the existence test can see them.
 *
 * These exist because a capability key is not always one product: 'microsoft'
 * covers Outlook and the enterprise directory, and 'jira' covers both Jira and
 * Service Management. Same gate, different pictures.
 */
export const EXTRA_LOGOS = ['outlook', 'microsoft', 'jira-jsm', 'atlassian', 'directory'] as const;

/**
 * Marks we deliberately do not ship, which render the built-in glyph.
 *
 * `knowledge`, `cards`, `agents` and `logs` are our own surfaces rather than
 * products — the built-in glyph says that better than any vendor-style
 * file would.
 *
 * `directory` is NOT here. It has no vendor logo either — it names a Renkei
 * bundle of Graph scopes, not a Microsoft product — but a real asset beats a
 * fallback for something rendered on every visit, so it ships original
 * artwork instead. The glyph case for it stays in connector-icon.tsx as the
 * degradation path, same as every other mark.
 */
export const GLYPH_ONLY = new Set(['knowledge', 'cards', 'agents', 'fileshares', 'logs']);

/** Explicit prop, then the known-mismatch table, then the key itself. */
export function resolveLogoFile(capabilityKey: string, logo?: string): string {
  return logo ?? LOGO_FILE[capabilityKey] ?? capabilityKey;
}
