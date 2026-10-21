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
  // Jira Administration is a separate connector/capability key from 'jira',
  // but the same product and the same mark — the onbase-admin arrangement.
  'jira-admin': 'jira',
  // OnBase Administration is a separate connector/capability key from
  // 'onbase', but the same Hyland product and the same mark.
  'onbase-admin': 'onbase',
  // Entra Developer is a second Entra app registration on its own key; the
  // company mark is the honest picture for a directory-level product, the
  // same reasoning the enterprise-directory panel gives for 'microsoft'.
  'entra-developer': 'microsoft',
  // The WebEx bot is a second registration of the same product.
  'webex-bot': 'webex',
  // Renkei's own built-in surfaces wear Renkei's mark — one file, many keys.
  cards: 'renkei',
  agents: 'renkei',
  'batch-jobs': 'renkei',
  logs: 'renkei',
  'user-memory': 'renkei',
  sandbox: 'renkei',
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
 * `knowledge`, `web-search`, `voice` and `mistral-ocr` are our own surfaces
 * rather than products, each with a built-in glyph that says what it does.
 * The other built-in surfaces (cards, agents, batch jobs, logs, memory, the
 * sandbox) are mapped to Renkei's own mark in LOGO_FILE instead.
 *
 * `directory` is NOT here. It has no vendor logo either — it names a Renkei
 * bundle of Graph scopes, not a Microsoft product — but a real asset beats a
 * fallback for something rendered on every visit, so it ships original
 * artwork instead. The glyph case for it stays in connector-icon.tsx as the
 * degradation path, same as every other mark.
 */
export const GLYPH_ONLY = new Set([
  'knowledge',
  'fileshares',
  // Web search is a Renkei surface over an Azure deployment, not a product
  // of its own — and drawing Bing's or Azure's mark for it would claim
  // more than it is.
  'web-search',
  // The OCR stage: a Renkei pipeline stage, not a vendor product (Mistral's
  // mark would claim the wrong thing for a stage that happens to call it).
  'mistral-ocr',
  // Voice is the chat speaking and listening through an org-provisioned
  // speech service; drawing that vendor's mark would name the wrong thing.
  'voice',
  // Same reasoning for ADManager Plus: no ManageEngine mark has been
  // vetted for this connector yet — the built-in glyph renders until one
  // is added the same way.
  'admanager',
  // MCP servers are whatever the org lists, not one product; no mark fits.
  'mcp',
]);

/**
 * Marks drawn in black, which vanish on a dark card: they render inverted in
 * dark mode. An SVG loaded through <img> cannot see the page's theme (it is
 * the `data-theme` attribute, not the system setting), so the page inverts
 * it rather than the file switching itself.
 */
export const INVERT_ON_DARK = new Set(['github']);

/** Explicit prop, then the known-mismatch table, then the key itself. */
export function resolveLogoFile(capabilityKey: string, logo?: string): string {
  return logo ?? LOGO_FILE[capabilityKey] ?? capabilityKey;
}
