'use client';

import { useState } from 'react';
import { resolveLogoFile, GLYPH_ONLY } from '@/lib/connector-logos';

/**
 * A small mark per connector, so a page of eight cards can be scanned rather
 * than read.
 *
 * Prefers the vendor's OFFICIAL logo from `public/connector-logos/` (see the
 * README there for what to add and the brand terms that govern it), and falls
 * back to a built-in glyph when that file is absent.
 *
 * The fallbacks are original shapes in each product's brand colour —
 * deliberately not imitations of the official marks. Approximating a
 * trademark from memory produces something that looks authoritative and is
 * subtly wrong, which is worse than an obvious abstraction. They exist so a
 * fresh checkout has usable visuals and so a missing asset degrades to
 * something honest rather than a broken image.
 *
 * The fallback is inline SVG, so the no-logo path costs no network request.
 */

interface IconProps {
  /** Rendered HEIGHT in pixels; the built-in glyphs are drawn on a 24-unit grid. */
  size?: number;
  /**
   * Width ceiling for wide marks. Defaults to 4× the height, which fits
   * everything up to a 4:1 wordmark at full height and letterboxes anything
   * wider rather than letting one logo run away with the row.
   */
  maxWidth?: number;
  className?: string;
}

const BRAND: Record<string, string> = {
  jira: '#2684FF',
  // Amber, not Jira's blue: the shipped mark is black-on-amber, and a
  // fallback that changes colour is a fallback nobody recognises as the same
  // product.
  'jira-jsm': '#FFAB00',
  confluence: '#1868DB',
  atlassian: '#1868DB',
  outlook: '#0F6CBD',
  microsoft: '#5E5E5E',
  // Neutral on purpose: we ship no vendor mark for the directory, so claiming
  // a brand colour for it would be inventing one.
  directory: '#475569',
  sharepoint: '#038387',
  onedrive: '#0364B8',
  webex: '#00CF64',
  zoom: '#0B5CFF',
  // Hyland's green; we ship no vendor mark (GLYPH_ONLY), so the glyph
  // below carries the colour.
  onbase: '#78BE20',
  knowledge: '#7C3AED',
  // A neutral sky blue: no vendor mark is shipped (GLYPH_ONLY), so the
  // globe below carries the colour.
  'web-search': '#0284C7',
};

/** Fallback: the connector's initial on a neutral tile. */
function InitialGlyph({ label, color }: { label: string; color: string }) {
  return (
    <>
      <rect width="24" height="24" rx="5" fill={color} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="12"
        fontWeight="600"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
      >
        {label.slice(0, 1).toUpperCase()}
      </text>
    </>
  );
}

/**
 * Keyed on the LOGO name, not the capability key: this draws a stand-in for
 * the mark that failed to load, so it has to follow whichever mark that was.
 * Outlook and the directory both sit on the 'microsoft' capability but are
 * different pictures.
 */
function glyphFor(logo: string, label: string) {
  const color = BRAND[logo] ?? '#6B7280';

  switch (logo) {
    // Jira: stacked chevrons, echoing its arrow-through-diamond shape.
    case 'jira':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <path d="M12 5l5 5-5 5-5-5z" fill="#fff" opacity="0.95" />
          <path d="M12 12l4 4-4 3-4-3z" fill="#fff" opacity="0.55" />
        </>
      );
    // Service Management: a ring, for the on-call/alert rotation it covers.
    // Distinct from Jira's chevrons because the two sit side by side.
    case 'jira-jsm':
      // Dark ink rather than the white every other glyph uses — white on
      // amber is barely legible, and the real mark is dark-on-amber anyway.
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle cx="12" cy="12" r="5" stroke="#172B4D" strokeWidth="1.8" fill="none" />
          <circle cx="12" cy="12" r="1.6" fill="#172B4D" />
        </>
      );
    // Confluence: two swept planes.
    case 'confluence':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <path d="M4 15c4-5 8-5 16-1v4c-8-3-12-3-16 1z" fill="#fff" opacity="0.95" />
          <path d="M20 9C16 4 12 4 4 8v-3c8-3 12-3 16 1z" fill="#fff" opacity="0.6" />
        </>
      );
    // Outlook: an envelope. NOT 'microsoft' — that key now carries the
    // company mark, which has no honest abstraction (four coloured squares
    // IS the logo), so it falls through to the lettered tile below.
    case 'outlook':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <path d="M5 8h14v9H5z" fill="#fff" opacity="0.95" />
          <path d="M5 8l7 5 7-5" stroke={color} strokeWidth="1.6" fill="none" />
        </>
      );
    // Directory: three people. Shipped as a glyph rather than a vendor mark
    // so it cannot be mistaken for the Microsoft card that contains it.
    case 'directory':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle cx="12" cy="9" r="2.6" fill="#fff" opacity="0.95" />
          <circle cx="6.6" cy="11" r="1.9" fill="#fff" opacity="0.6" />
          <circle cx="17.4" cy="11" r="1.9" fill="#fff" opacity="0.6" />
          <path d="M7.5 18c.6-2.4 2.4-3.6 4.5-3.6s3.9 1.2 4.5 3.6z" fill="#fff" opacity="0.95" />
        </>
      );
    // SharePoint: linked sites.
    case 'sharepoint':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle cx="9" cy="9" r="3.2" fill="#fff" opacity="0.95" />
          <circle cx="16" cy="14" r="4" fill="#fff" opacity="0.6" />
          <circle cx="8.5" cy="16.5" r="2.4" fill="#fff" opacity="0.8" />
        </>
      );
    // OneDrive: a cloud.
    case 'onedrive':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <path
            d="M8.5 16.5h8.2a2.8 2.8 0 0 0 .2-5.6 4.2 4.2 0 0 0-7.8-1.5A3.3 3.3 0 0 0 8.5 16.5z"
            fill="#fff"
            opacity="0.95"
          />
        </>
      );
    // WebEx: concentric arcs, its "signal" idea.
    case 'webex':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle cx="12" cy="12" r="2.6" fill="#fff" />
          <path
            d="M7.2 7.2a6.8 6.8 0 0 0 0 9.6M16.8 7.2a6.8 6.8 0 0 1 0 9.6"
            stroke="#fff"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            opacity="0.75"
          />
        </>
      );
    // Zoom: a video camera.
    case 'zoom':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <rect x="5" y="8.5" width="9.5" height="7" rx="2" fill="#fff" opacity="0.95" />
          <path d="M15.5 11.5l3.5-2v5l-3.5-2z" fill="#fff" opacity="0.75" />
        </>
      );
    // Knowledge: a magnifier, since it is a search surface rather than a product.
    case 'knowledge':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle
            cx="11"
            cy="11"
            r="4"
            stroke="#fff"
            strokeWidth="1.8"
            fill="none"
            opacity="0.95"
          />
          <path d="M14.2 14.2L18 18" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    // OnBase: a document sheet with index lines — it is a document store,
    // and the keyword index is the part Renkei talks to.
    case 'onbase':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <path d="M7 5h7l3 3v11H7z" fill="#fff" opacity="0.95" />
          <path d="M14 5v3h3" fill="none" stroke={color} strokeWidth="1.2" />
          <path d="M9 12h6M9 15h6" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    // Web search: a globe — a search surface over the public web, not a product.
    case 'web-search':
      return (
        <>
          <rect width="24" height="24" rx="5" fill={color} />
          <circle cx="12" cy="12" r="6.5" stroke="#fff" strokeWidth="1.6" fill="none" />
          <path
            d="M5.5 12h13M12 5.5c-2.4 2.2-2.4 10.8 0 13M12 5.5c2.4 2.2 2.4 10.8 0 13"
            stroke="#fff"
            strokeWidth="1.3"
            fill="none"
            opacity="0.85"
          />
        </>
      );
    default:
      return <InitialGlyph label={label} color={color} />;
  }
}

export default function ConnectorIcon({
  capabilityKey,
  label,
  logo,
  size = 24,
  maxWidth,
  className,
}: IconProps & { capabilityKey: string; label: string; logo?: string }) {
  // Assume the official asset is present and step down on error, rather than
  // probing first: the common deployment has the logos, and a HEAD request
  // per icon to find out would cost more than the occasional fallback.
  const [logoMissing, setLogoMissing] = useState(false);

  const file = resolveLogoFile(capabilityKey, logo);

  // Marks we knowingly do not ship go straight to the glyph. Letting them
  // take the optimistic path would 404 on every render of every card, to
  // arrive at the answer already known here.
  if (!logoMissing && !GLYPH_ONLY.has(file)) {
    return (
      // Plain <img>, not next/image: these are tiny static SVGs already in
      // the bundle's public dir, so the optimizer has nothing to optimize and
      // would only add a loader hop.
      <img
        src={`/connector-logos/${file}.svg`}
        alt=""
        height={size}
        // Height is fixed and WIDTH FOLLOWS the mark's own proportions,
        // because the official assets are anything but square: SharePoint is
        // 0.9:1, OneDrive 1.5:1, Zoom 4.4:1, the Confluence lockup 8:1.
        // Forcing a square box would squash a wordmark into an unreadable
        // smear — and a stretched mark is a modified mark, which brand terms
        // reliably forbid. object-contain letterboxes anything past the
        // width ceiling instead of distorting it.
        style={{ height: size, width: 'auto', maxWidth: maxWidth ?? size * 4 }}
        className={`object-contain ${className ?? ''}`}
        onError={() => setLogoMissing(true)}
        // Decorative: the label is always rendered beside it, so announcing
        // the mark too would make a screen reader say everything twice.
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {glyphFor(file, label)}
    </svg>
  );
}
