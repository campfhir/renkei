/**
 * The `email` object, as TypeScript — what the editor autocompletes against.
 *
 * This is a declaration file kept as a string because Monaco takes extra
 * libraries that way. It has one job and one hazard: it must describe the
 * object the sandbox ACTUALLY builds. An editor that autocompletes a field
 * the guest never receives is worse than no autocomplete at all, because
 * the script it helps you write fails silently in production — a script
 * error is a recorded no-op, so the message just indexes uncleaned.
 *
 * The source of truth is `CleanerScriptInput` and the JSON marshalling in
 * `packages/email-sanitizer/src/scripts/run.ts`. A field added there must be
 * added here, and `cleaner-types.test.ts` fails if the two drift.
 */

export const CLEANER_TYPES = `
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
 * Whatever this script was pointed at. Narrow on \`kind\` to reach the
 * fields that only one of them has:
 *
 *     function clean(item: CleanerItem): string {
 *       if (item.kind !== 'evt') return item.text;
 *       return item.attendees.length > 12 ? '' : item.text;
 *     }
 */
type CleanerItem = CleanerMessage | CleanerEvent | CleanerTask;

/**
 * Every field, whatever the kind — the shape the sandbox literally passes,
 * with the calendar fields null or empty for a message or a task.
 *
 * Use \`CleanerMessage\`, \`CleanerEvent\` or \`CleanerTask\` when a script
 * handles one kind, and \`CleanerItem\` when it handles several: those say
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
`;

/** Every field the editor claims exists, for the drift test to check. */
export const CLEANER_FIELDS: readonly string[] = [
  'text',
  'kind',
  'subject',
  'fromAddress',
  'fromName',
  'senderAddress',
  'replyToAddress',
  'messageId',
  'receivedAt',
  'organizer',
  'attendees',
  'location',
  'startsAt',
  'endsAt',
  'isOnline',
];

/** Fields that only a calendar invite really carries. */
export const CALENDAR_ONLY_FIELDS: readonly string[] = [
  'organizer',
  'attendees',
  'location',
  'startsAt',
  'endsAt',
  'isOnline',
];
