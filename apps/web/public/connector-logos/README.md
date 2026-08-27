# Connector logos

SVGs here are named after the connector's **capabilityKey**
(`apps/web/lib/connector-catalog.ts`) by default. `ConnectorIcon` requests
`/connector-logos/{name}.svg` and falls back to a built-in glyph when the file
is absent, so the UI works with none, some, or all present. Adding a file is
the whole deployment step.

## When the filename is not the capabilityKey

Two cases break the default, and both are resolved in `connector-icon.tsx`
rather than by renaming anything:

- **One key, several marks.** Outlook and the enterprise directory are both
  the `microsoft` capability, but they are different pictures. The caller
  passes an explicit `logo` prop.
- **A key that reads like a suite.** Confluence is provisioned as
  `atlassian-confluence`, but its mark is the product logo. The `LOGO_FILE`
  table maps the key to `confluence`.

Do **not** rename a capabilityKey to match a file. That key is persisted in
org settings as `disabledConnectors` and gates tool registration, so renaming
it silently re-enables the connector for every org that had switched it
off — a permissions change made by moving an image.

## Present

All from Wikimedia Commons, each listed there as public domain — these marks
sit below the threshold of originality for copyright. Trademark still governs
use; see below.

Ratios below are measured from each file's `viewBox`, not estimated.

| File             | Source                                           | Ratio |
| ---------------- | ------------------------------------------------ | ----- |
| `sharepoint.svg` | `Microsoft Office SharePoint (2025–present).svg` | 0.90  |
| `microsoft.svg`  | _record source_                                  | 1.00  |
| `outlook.svg`    | `Microsoft Outlook Icon (2025–present).svg`      | 1.06  |
| `onedrive.svg`   | `Microsoft OneDrive Icon (2025 - present).svg`   | 1.50  |
| `confluence.svg` | _record source_                                  | 1.00  |
| `atlassian.svg`  | _record source_                                  | 1.00  |
| `jira.svg`       | _record source_                                  | 1.00  |
| `jira-jsm.svg`   | _record source_                                  | 1.00  |
| `bitbucket.svg`  | _record source_                                  | 1.00  |
| `webex.svg`      | `Cisco Webex logo - Brandlogos.net.svg`          | 2.64  |
| `zoom.svg`       | _record source_                                  | 1.00  |
| `directory.svg`  | **ours** — original artwork, not a vendor mark   | 1.00  |
| `onbase.svg`     | **ours** — vector recreation of the official OnBase app icon (Hyland), supplied in-session; not a Commons asset | 1.00  |

**The `_record source_` rows need filling in.** This table is the provenance
record for third-party trademarks, so an unattributed asset is the one thing
it cannot carry — whoever added the file knows where it came from, and that is
the only moment the answer is cheap. Marked rather than guessed: a plausible
Commons filename written from memory is worse than a blank, because it reads
as verified.

The Atlassian marks also ship `-gray` and `-white` variants. Nothing requests
those yet; they are here so a future dark-on-light surface has an approved
asset rather than a recoloured one.

`bitbucket.svg` has no connector behind it. It is staged for one.

`directory.svg` is the one file here we drew. It marks the "Enterprise
directory" panel — a Renkei bundle of Graph people/group scopes, not a
Microsoft product — so there is no vendor mark to use. Microsoft's own would
have been the obvious choice and is the one that cannot work: the Microsoft
365 card containing that panel already wears it, and a panel showing its
parent's logo reads as a duplicate. Being ours, it is the only asset here free
to be edited.

`knowledge.svg` is absent on purpose: it is our own search surface, not a
vendor product, so it renders the built-in glyph.

### On those ratios

Most are now square or near it, and WebEx at 2.64:1 is the outlier. Do not
take that as licence to assume squares: `ConnectorIcon` fixes HEIGHT and lets
width follow the mark's own proportions, capped at 4× height by default
(`maxWidth` overrides). A wordmark therefore stays legible instead of being
squashed, and nothing is ever stretched — a distorted mark is a modified mark,
which brand terms reliably forbid. The next asset someone adds may well be a
lockup.

Where marks sit in a list, put them in a fixed-width slot (see
`connector-availability.tsx`) so a wide wordmark beside a square tile still
leaves every label starting at the same place.

Prefer the square/icon variant wherever the vendor offers both. These render
at 18–28px beside a label that already says the product name, so the wordmark
in a lockup only repeats it — which is why Jira and Zoom were swapped from
their 2.4:1 and 4.4:1 lockups to the icon forms.

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
