/**
 * The tag every message a mockup's document posts to its frame carries —
 * shared by the document's own script (document.ts, server) and the page
 * that listens (mockup-frame.ts, browser), so it lives where both may
 * import it.
 */
export const MOCKUP_MESSAGE_SOURCE = 'renkei-mockup';
