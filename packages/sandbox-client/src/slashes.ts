/**
 * `value` without its trailing slashes. A loop, not `/\/+$/`: on a long
 * run of slashes that does not end the string, that expression backtracks
 * over it again and again, and these values come from outside.
 */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
