/**
 * The generic human-mail cleaning chain. Every step is anchored to a real
 * structural or literal marker — an exact divider format, an RFC-defined
 * delimiter, a literal boilerplate phrase — never fuzzy keyword scoring that
 * could misfire on real correspondence. Order matters: the quoted chain (and
 * anything nested inside it, including old signatures/footers) is removed
 * first, then this message's own signature, then any trailing legal footer,
 * then URL de-fluffing on whatever prose remains.
 */

import { collapseWhitespace } from '../normalize';
import { SEED_BANNERS } from '../registry/seed';

/**
 * A literal warning-banner phrase, as a case-insensitive regex that matches
 * across whitespace/line-wrap reflow rather than the exact literal string —
 * same approach as the template engine's `literalToRegex` — so a mail
 * client's line-wrapping can't split a banner across two lines and dodge
 * the match.
 */
function phraseToRegex(phrase: string): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'), 'i');
}

/**
 * Strip mail-gateway/transport-rule "external sender" warning banners — not
 * authored by the sender, so they must come out before embedding. Unlike
 * `stripLegalFooter` below, a banner is (almost always) the very first
 * paragraph with the sender's real content immediately after it, so only
 * the matching banner text is cut, not everything downstream of it.
 *
 * `patterns` is the tenant's live library
 * (`packages/email-sanitizer/src/persistence/banners.ts`, admin-managed at
 * `/[slug]/admin/email-sanitizer`) — a periodically-updated list, since a
 * new gateway wording is exactly the kind of thing that shouldn't need a
 * code deploy. Defaults to the built-in `SEED_BANNERS` so a direct caller
 * (fixtures, anything not going through `sanitizeEmailForTenant`) still
 * gets the two verified defaults.
 */
export function stripExternalSenderBanner(
  text: string,
  patterns: readonly string[] = SEED_BANNERS
): string {
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(phraseToRegex(pattern), '');
  }
  return result;
}

/**
 * Structural markers that start a quoted reply chain. Each is anchored to a
 * real client's literal divider format, not a guess at where "the old stuff"
 * begins.
 */
const QUOTE_DIVIDERS: RegExp[] = [
  // Outlook desktop's plain-text divider.
  /^-{3,}\s*Original Message\s*-{3,}$/im,
  // Outlook's header block for a forwarded/replied message.
  /^From:.*\r?\nSent:.*\r?\nTo:.*\r?\nSubject:.*$/im,
  // Gmail/Apple Mail/most webmail clients' reply attribution line.
  /^On .{0,120} wrote:\s*$/im,
];

export function truncateQuotedChain(text: string): string {
  let cut = text.length;
  for (const divider of QUOTE_DIVIDERS) {
    const match = divider.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut).trimEnd();
}

/** RFC 3676 §4.3's exact signature delimiter: a line that is only "-- ". */
const SIGNATURE_DELIMITER = /^-- ?$/m;

export function truncateSignatureDelimiter(text: string): string {
  const match = SIGNATURE_DELIMITER.exec(text);
  return match ? text.slice(0, match.index).trimEnd() : text;
}

/**
 * Literal phrases that only ever appear inside a legal/confidentiality
 * footer. Everything from the first matching line to the end is dropped.
 * Deliberately a short, precise list rather than broad keyword scoring —
 * a false match here would truncate real correspondence.
 */
export const LEGAL_FOOTER_ANCHORS = [
  'this message and any attachments',
  'this e-mail and any attachments',
  'this email and any attachments',
  'confidentiality notice',
  'this e-mail may contain confidential',
  'this email may contain confidential',
  'this message may contain confidential',
  'is intended only for the use of the individual',
  'if you are not the intended recipient',
  'please consider the environment before printing',
];

export function stripLegalFooter(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (LEGAL_FOOTER_ANCHORS.some((anchor) => lower.includes(anchor))) {
      return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  return text;
}

const SAFE_LINKS_HOST = /^https:\/\/[a-z0-9.-]*\.safelinks\.protection\.outlook\.com\//i;

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
  'fbclid',
  'gclid',
]);

function unwrapSafeLinks(url: string): string {
  if (!SAFE_LINKS_HOST.test(url)) return url;
  try {
    const parsed = new URL(url);
    const inner = parsed.searchParams.get('url');
    return inner || url;
  } catch {
    return url;
  }
}

function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return url;
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return url;
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Unwrap known tracking-redirect wrappers and strip tracking query params from bare URLs. */
export function defluffUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => stripTrackingParams(unwrapSafeLinks(match)));
}

export function cleanHumanMail(text: string, bannerPatterns?: readonly string[]): string {
  const unbannered = stripExternalSenderBanner(text, bannerPatterns);
  const dequoted = truncateQuotedChain(unbannered);
  const unsigned = truncateSignatureDelimiter(dequoted);
  const footerless = stripLegalFooter(unsigned);
  const detracked = defluffUrls(footerless);
  return collapseWhitespace(detracked);
}
