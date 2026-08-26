/**
 * The ambient environment a cleaner script is pasted into.
 *
 * The numbered files beside this one are payloads, not modules: an admin
 * copies each one verbatim into **Admin → Email sanitizer → Cleaner
 * scripts**, where the sandbox evaluates it as `const __fn = ( <file> );`.
 * So they cannot carry an import, and the types they annotate against have
 * to arrive from somewhere else — in the editor from the declarations
 * Monaco is fed, and here from this file.
 *
 * Without it `tsc` reads `email: CleanerMessage` as a reference to a name
 * that does not exist and the package fails to typecheck, which is what it
 * did between `06f72a2` and this file existing.
 *
 * This is the THIRD rendering of one shape. The other two are the JSON
 * literal in `src/scripts/run.ts` (what the guest is really handed — the
 * source of truth) and `CLEANER_TYPES` in
 * `apps/web/lib/email-sanitizer/cleaner-types.ts` (what the editor
 * autocompletes). Keep all three identical: a field declared here but never
 * marshalled produces a script that reads `undefined`, and a script error
 * is a recorded no-op, so the message indexes uncleaned and nothing in the
 * UI says so. `cleaner-types.test.ts` fails if they drift.
 *
 * Nothing here is emitted or shipped. It exists only so the payloads can be
 * compiled in the same shape they will run in.
 */

/** Fields every kind carries. */
interface CleanerItemBase {
  /**
   * The body as cleaned so far — links already decoded, whitespace tidied.
   * Transform this and return the result.
   */
  text: string;

  subject: string;
  fromAddress: string;
  fromName: string;

  /** The authenticated sender, when it differs from the visible From. */
  senderAddress: string | null;
  replyToAddress: string | null;
  /** The RFC Message-ID. System relays often tag these distinctively. */
  messageId: string | null;
  receivedAt: string | null;
}

/** An email message. */
interface CleanerMessage extends CleanerItemBase {
  kind: 'msg';
}

/**
 * A calendar invite. The extra fields here are the reason to narrow: an
 * invite's boilerplate is anchored to its structure, and a script that
 * knows the meeting is online can be far more confident about what is
 * conferencing chrome and what is the agenda.
 */
interface CleanerEvent extends CleanerItemBase {
  kind: 'evt';
  organizer: string | null;
  attendees: string[];
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isOnline: boolean;
}

/** A to-do item from Microsoft To Do or Planner. Bodies are short. */
interface CleanerTask extends CleanerItemBase {
  kind: 'task';
}

/**
 * Whatever this script was pointed at. Narrow on `kind` to reach the
 * fields that only one of them has.
 */
type CleanerItem = CleanerMessage | CleanerEvent | CleanerTask;

/**
 * Every field, whatever the kind — the shape the sandbox literally passes,
 * with the calendar fields null or empty for a message or a task.
 *
 * Use `CleanerMessage`, `CleanerEvent` or `CleanerTask` when a script
 * handles one kind, and `CleanerItem` when it handles several: those say
 * what is really available and make the compiler stop you from reading an
 * attendee list off an email. This looser type stays because it is honest
 * about the runtime and because scripts already written against it keep
 * working.
 */
interface CleanerEmail extends CleanerItemBase {
  kind: 'msg' | 'evt' | 'task';
  organizer: string | null;
  attendees: string[];
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isOnline: boolean;
}

/**
 * A cleaner script: one function, taking the item and returning the text to
 * index. Return the text unchanged when nothing applies.
 */
declare type CleanerScript = (email: CleanerEmail) => string;

/** The same object under a name that does not lie when it is a meeting. */
declare const item: CleanerEmail;
