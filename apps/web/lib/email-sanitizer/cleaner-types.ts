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
/** One message, invite or task, as the sandbox hands it to your script. */
interface CleanerEmail {
  /**
   * The body as cleaned so far — links already decoded, whitespace tidied.
   * Transform this and return the result.
   */
  text: string;

  /**
   * Which kind of thing you are looking at. Branch on it when one script
   * serves more than one kind:
   *
   *     if (email.kind !== 'evt') return email.text;
   */
  kind: 'msg' | 'evt' | 'task';

  subject: string;
  fromAddress: string;
  fromName: string;

  /** The authenticated sender, when it differs from the visible From. */
  senderAddress: string | null;
  replyToAddress: string | null;
  /** The RFC Message-ID. System relays often tag these distinctively. */
  messageId: string | null;
  receivedAt: string | null;

  /** Calendar invites only; null or empty for other kinds. */
  organizer: string | null;
  attendees: string[];
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isOnline: boolean;
}

/**
 * A cleaner script: one function, taking the item and returning the text to
 * index. Return \`email.text\` unchanged when nothing applies.
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
