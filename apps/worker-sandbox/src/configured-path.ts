/**
 * Directories this worker is pointed at through the environment. Each one
 * ends up inside commands the worker starts — a checkout's HOME on a
 * language server's argv, a run's directory on an interpreter's — so a
 * value is held to a plain absolute path: letters, digits, `_ . + -` and
 * `/`, with no `..` segment. Anything else is an operator's typo, refused
 * at boot where it can be fixed, rather than a string a shell or `ps`
 * would misread later.
 */
export function configuredDirectory(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (/^\/[A-Za-z0-9_.+/-]*$/.test(value) && !value.split('/').includes('..')) return value;
  throw new Error(
    `${name} must be an absolute path made of letters, digits, '_', '.', '+', '-' and '/' with no '..' segment: ${JSON.stringify(value)}`
  );
}
