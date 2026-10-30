/**
 * The name the browser saves a checkout download as: a file's own name;
 * a folder as `<folder>.zip`; the whole checkout as `<repo>.zip`.
 */
export function downloadName(path: string, repoFullName: string, kind: 'file' | 'dir'): string {
  const last = (value: string) => value.slice(value.lastIndexOf('/') + 1);
  if (kind === 'file') return last(path) || 'file';
  return `${path ? last(path) : last(repoFullName) || 'checkout'}.zip`;
}
