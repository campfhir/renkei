# Connector logos

SVGs here are named after the connector's **capabilityKey**
(`apps/web/lib/connector-catalog.ts`). `ConnectorIcon` requests
`/connector-logos/{capabilityKey}.svg` and falls back to a built-in glyph when
the file is absent, so the UI works with none, some, or all present. Adding a
file is the whole deployment step.

## Present

All from Wikimedia Commons, each listed there as public domain — these marks
sit below the threshold of originality for copyright. Trademark still governs
use; see below.

| File                       | Commons source                                   | Ratio |
| -------------------------- | ------------------------------------------------ | ----- |
| `sharepoint.svg`           | `Microsoft Office SharePoint (2025–present).svg` | 0.90  |
| `atlassian-confluence.svg` | `Atlassian Confluence 2017 logo (cropped).svg`   | 1.00  |
| `microsoft.svg`            | `Microsoft Outlook Icon (2025–present).svg`      | 1.06  |
| `onedrive.svg`             | `Microsoft OneDrive Icon (2025 - present).svg`   | 1.50  |
| `jira.svg`                 | `Jira Logo.svg`                                  | 2.38  |
| `webex.svg`                | `Cisco Webex logo - Brandlogos.net.svg`          | 2.64  |
| `zoom.svg`                 | `Zoom Logo 2022.svg`                             | 4.40  |

`knowledge.svg` is absent on purpose: it is our own search surface, not a
vendor product, so it renders the built-in glyph.

### On those ratios

They span 0.9:1 to 4.4:1, and `ConnectorIcon` is built around that rather
than assuming squares. It fixes HEIGHT and lets width follow the mark's own
proportions, capped at 4× height by default (`maxWidth` overrides). A
wordmark therefore stays legible instead of being squashed, and nothing is
ever stretched — a distorted mark is a modified mark, which brand terms
reliably forbid.

Where marks sit in a list, put them in a fixed-width slot (see
`connector-availability.tsx`) so a 4:1 wordmark beside a square tile still
leaves every label starting at the same place.

Prefer the square/icon variant when Commons offers both — Confluence has a
`(cropped)` file that is the mark alone, where the plain one is an 8:1 lockup
whose wordmark just repeats the label sitting next to it.

## Before adding one

These are third-party trademarks, not ours. Vendors generally permit their
marks to identify an integration, and generally prohibit altering them,
implying endorsement, or using them as your own product identity — but the
terms are per-vendor and they change. **Read the vendor's current brand
guidelines before committing their asset**, and prefer the plain product mark
over lockups or wordmarks that include the vendor's name.

Practical notes:

- Prefer the **square/icon** form. These render at 20–28px next to a label
  that already says the product name, so a horizontal wordmark is illegible
  and redundant.
- Keep the vendor's own `viewBox`; the component sizes with width/height and
  does not assume a 24-unit grid for these.
- Strip nothing. An SVG edited to "fit better" is a modified mark, which is
  the thing brand terms most reliably forbid.
- Do not recolour, including for dark mode. If a mark disappears on a dark
  background, put it on a light tile rather than altering it.

## Why there is a fallback at all

The built-in glyphs in `connector-icon.tsx` are original shapes in each
product's brand colour — deliberately _not_ imitations of the official marks.
They exist so a fresh checkout has usable visuals, and so a missing or
withdrawn asset degrades to something honest instead of a broken image.
