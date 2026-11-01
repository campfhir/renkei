/**
 * What the line under a file a reply produced (file-caption.tsx) says
 * about its size: bytes, KB rounded, or MB to a tenth. Tested in
 * file-caption.model.test.ts.
 */

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
