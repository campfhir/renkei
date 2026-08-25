# Cleaner script library

Ready-to-paste cleaner scripts that reproduce the built-in heuristics deleted in
`6eddec8`, when cleaning consolidated onto scripts as its single mechanism.

Nothing here is installed automatically. These are sources you paste into
**Admin → Email sanitizer → Cleaner scripts**, review, dry-run against your own
mail, and save. That is the point of the change: an organization decides what
counts as noise in its own correspondence, rather than inheriting our decision.

## What is here

| Script                           | Runs on  | Replaces                       |
| -------------------------------- | -------- | ------------------------------ |
| `01-quoted-reply-chains.ts`      | Email    | `truncateQuotedChain`          |
| `02-signature-blocks.ts`         | Email    | `truncateSignatureDelimiter`   |
| `03-legal-footers.ts`            | Email    | `stripLegalFooter`             |
| `04-external-sender-banners.ts`  | Email    | `SEED_BANNERS` stripping       |
| `05-conferencing-boilerplate.ts` | Calendar | `stripConferencingBoilerplate` |

## Installing

Paste the file contents — **including the leading comments**, which are the only
documentation a future admin gets — into the script editor, set **Runs on** to
the column above, dry-run against a real sample, then save.

**Order matters for the email scripts.** Scripts run in the order they were
created, and `01` should be first: truncating the quoted chain removes every
signature and footer nested inside it, so the later scripts have far less to do
and far less opportunity to misfire on quoted text. `02`, `03` and `04` are
independent of each other.

Install only what you want. A tenant whose mail has no gateway banner should not
run `04`, and a tenant that wants quoted chains kept in the index should skip
`01` — that decision is now yours to make and is the reason these are not
seeded.

### If you already have an "External-sender banners" script

Migration `055` generated one from the phrases your organization had configured.
Do not install `04` alongside it — merge instead: add the two phrases from `04`
into the existing script's `phrases` array. Running both is harmless but means
two sandbox invocations doing one job.

## Verifying

```
pnpm --filter @renkei/email-sanitizer verify:cleaners
```

Runs every script in the **real QuickJS sandbox with production limits**, against
the cases in `cases/`. Those cases are the original fixtures from the deleted
code, recovered verbatim, so a pass means a script reproduces the removed
behaviour exactly rather than approximately. Each script is also run against a
~72KB body to prove it finishes inside the 250ms budget — a timeout in
production is a silent no-op that indexes the message uncleaned, so it is worth
catching here.

No database, no network, nothing installed. Run it after editing any script.

## Writing your own

Scripts are TypeScript. The editor runs the TypeScript language service
against the declarations in `apps/web/lib/email-sanitizer/cleaner-types.ts`,
so `email.` completes to the real fields and a wrong type is underlined as you
type. Types are stripped when you save; the sandbox runs the JavaScript.

Write a **named** function — `function clean(email: CleanerEmail): string` —
because that is valid TypeScript on its own and is what lets the editor check
the file. An anonymous `function (email) { }` or an arrow still works
everywhere (the compiler and the sandbox both parenthesise it); the editor
just flags it as a declaration missing a name.

Type the parameter for the reach you chose — the editor seeds this for you:

| Runs on       | Type             |
| ------------- | ---------------- |
| Email         | `CleanerMessage` |
| Calendar      | `CleanerEvent`   |
| Tasks         | `CleanerTask`    |
| More than one | `CleanerItem`    |

All of them carry `text` (the body so far — transform and return this),
`kind`, `subject`, `fromAddress`, `fromName`, `senderAddress`,
`replyToAddress`, `messageId` and `receivedAt`.

`CleanerEvent` adds what only an invite has: `organizer`, `attendees`,
`location`, `startsAt`, `endsAt`, `isOnline`. Those are deliberately
unreachable from `CleanerMessage` — on an email they are always null or
empty, so a script reading them would silently do nothing rather than fail
where you could see it.

`CleanerItem` is the union, so it narrows on `kind`:

```ts
function clean(item: CleanerItem): string {
  if (item.kind !== 'evt') return item.text;
  return item.attendees.length > 12 ? '' : item.text;
}
```

`CleanerEmail` also still exists — every field at once, matching what the
sandbox literally passes — for scripts written before the per-kind types.
Prefer the narrow ones.

Constraints: pure ES2020, no `require`/`fetch`/`fs`/timers/`Date.now`, 250ms,
32MB, must return a string. Return `email.text` unchanged when nothing applies.
TypeScript features that emit runtime code — `enum`, `namespace` — are
rejected at save, since a cleaner script must stay a single expression.

Two habits worth copying from these scripts:

- **Fail toward keeping.** Every rule in `05` refuses to drop a line carrying a
  link, an id or a phone number. Losing a join URL to tidy a chunk is a much
  worse outcome than leaving a line of boilerplate in.
- **Anchor on structure, not vibes.** `02` matches only the exact RFC 3676
  delimiter. Looser "this looks like a signature" rules eventually truncate a
  real sentence, and nobody notices until someone searches for it.
