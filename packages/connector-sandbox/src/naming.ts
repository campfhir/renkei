/**
 * Filename hygiene for staged files. The sandbox has no folder tree — every
 * file lives flat under its (tenantId, subject) scope, named by its own
 * generated id on disk — so all a filename has to be is a safe, displayable
 * label: no path separators, no traversal, no null bytes. Mirrors the same
 * rule `fileshare_request_file_upload` applies to a new file's name.
 */

const MAX_FILENAME_LENGTH = 255;

export function validateFilename(input: string): { ok: true; filename: string } | { ok: false } {
  const filename = input.trim();
  if (
    !filename ||
    filename.length > MAX_FILENAME_LENGTH ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    filename === '.' ||
    filename === '..'
  ) {
    return { ok: false };
  }
  return { ok: true, filename };
}
