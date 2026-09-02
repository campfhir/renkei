/**
 * The head of a document, for the chunks that lost it.
 *
 * Every connector's document opens with its own title — a mail's Subject
 * line, a Confluence page's `# title`, a Jira summary, a transcript's
 * `Meeting:` line — and chunk 1 carries it. Chunks 2..n do not: a 60k-char
 * page becomes thirty pieces, twenty-nine of which embed with no idea what
 * page they belong to, so a query naming the page ranks them as if they
 * were about something else entirely. Prepending a one-line header to the
 * EMBEDDING INPUT (never to the stored content) gives every piece its
 * document back. The same title, weighted higher than the body, is what
 * the lexical index matches on.
 *
 * Derived from metadata rather than passed by each connector so that
 * every ingest path — pipeline, notes, agent notes — gets it without
 * remembering to.
 */

/** Metadata keys a connector uses for a document's title, most specific first. */
const TITLE_KEYS = ['subject', 'topic', 'title', 'name', 'fileName'] as const;

/** How each title key reads as a header line. */
const TITLE_LABELS: Record<(typeof TITLE_KEYS)[number], string> = {
  subject: 'Subject',
  topic: 'Meeting',
  title: 'Title',
  name: 'Document',
  fileName: 'Document',
};

/** A header should locate a chunk, not compete with it for the model's attention. */
const MAX_TITLE_CHARS = 200;

function titleEntry(
  metadata: Record<string, unknown>
): { key: (typeof TITLE_KEYS)[number]; value: string } | null {
  for (const key of TITLE_KEYS) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    return {
      key,
      value:
        trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS - 1)}…` : trimmed,
    };
  }
  return null;
}

/** A document's title from whichever metadata key its connector set, or ''. */
export function titleOf(metadata: Record<string, unknown>): string {
  return titleEntry(metadata)?.value ?? '';
}

/**
 * The one-line header prepended to a chunk before embedding, or '' when the
 * metadata names no title. `Subject: Vendor contract renewal`, `Document:
 * Q3 roadmap.docx`.
 */
export function chunkContext(metadata: Record<string, unknown>): string {
  const entry = titleEntry(metadata);
  return entry ? `${TITLE_LABELS[entry.key]}: ${entry.value}` : '';
}

/** What the embedder sees for one chunk: the header, a blank line, the chunk. */
export function embeddingInput(context: string, chunk: string): string {
  return context ? `${context}\n\n${chunk}` : chunk;
}
