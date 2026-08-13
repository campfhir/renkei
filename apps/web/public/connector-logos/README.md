# Connector logos

Drop each vendor's official SVG here, named after the connector's
**capabilityKey** (`apps/web/lib/connector-catalog.ts`):

| File                       | Product                 | Where to get it                    |
| -------------------------- | ----------------------- | ---------------------------------- |
| `jira.svg`                 | Jira                    | Atlassian brand / design resources |
| `atlassian-confluence.svg` | Confluence              | Atlassian brand / design resources |
| `microsoft.svg`            | Outlook                 | Microsoft brand & trademark assets |
| `sharepoint.svg`           | SharePoint              | Microsoft brand & trademark assets |
| `onedrive.svg`             | OneDrive                | Microsoft brand & trademark assets |
| `webex.svg`                | Webex                   | Cisco/Webex brand resources        |
| `zoom.svg`                 | Zoom                    | Zoom brand guidelines              |
| `knowledge.svg`            | _(ours — not a vendor)_ | any in-house mark                  |

`ConnectorIcon` requests `/connector-logos/{capabilityKey}.svg` and falls back
to a built-in glyph when the file is absent, so the UI works with none, some,
or all of these present. Adding a file is the whole deployment step.

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
