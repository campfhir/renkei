/**
 * Worth-checking notes, as stored in agents.review_notes. Newer notes
 * carry a suggested fix beside the issue; older rows are bare strings —
 * both parse here so every reader shows whatever a row actually holds.
 */

export interface ReviewNote {
  issue: string;
  /** The checker's suggested correction, when it offered one. */
  fix?: string;
}

export function parseReviewNotes(value: unknown): ReviewNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReviewNote[] => {
    if (typeof entry === 'string' && entry.trim()) return [{ issue: entry }];
    if (typeof entry === 'object' && entry !== null) {
      const note: { issue?: unknown; fix?: unknown } = entry;
      if (typeof note.issue === 'string' && note.issue.trim()) {
        return [
          {
            issue: note.issue,
            ...(typeof note.fix === 'string' && note.fix.trim() ? { fix: note.fix } : {}),
          },
        ];
      }
    }
    return [];
  });
}
