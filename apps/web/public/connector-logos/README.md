# Connector logos

SVGs here are named after the connector's **capabilityKey**
(`apps/web/lib/connector-catalog.ts`). `ConnectorIcon` requests
`/connector-logos/{capabilityKey}.svg` and falls back to a built-in glyph when
the file is absent, so the UI works with none, some, or all present. Adding a
file is the whole deployment step.

## Present

Sourced from Wikimedia Commons, which lists each as public domain — these
marks fall below the threshold of originality for copyright. Trademark still
applies; see below.

| File                       | Commons source                                   |
| -------------------------- | ------------------------------------------------ |
| `atlassian-confluence.svg` | `Atlassian Confluence 2017 logo (cropped).svg`   |
| `microsoft.svg`            | `Microsoft Outlook Icon (2025–present).svg`      |
| `sharepoint.svg`           | `Microsoft Office SharePoint (2025–present).svg` |
| `onedrive.svg`             | `Microsoft OneDrive Icon (2025 - present).svg`   |

## Still wanted

Commons has **only wide wordmarks** for these three — no square icon exists
there, and a wordmark is illegible in a 20px row. They render the built-in
glyph until someone adds the icon-only mark from the vendor's own brand page:

| File        | Product | Note                                                    |
| ----------- | ------- | ------------------------------------------------------- |
| `jira.svg`  | Jira    | Atlassian publishes the icon separately from the lockup |
| `webex.svg` | Webex   | Cisco brand resources                                   |
| `zoom.svg`  | Zoom    | Zoom brand guidelines                                   |

`knowledge.svg` has no vendor at all — it is our own surface, so its glyph
stays unless someone draws an in-house mark for it.

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
