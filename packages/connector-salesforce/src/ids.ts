/**
 * Salesforce record ids: 15-character case-sensitive, or the 18-character
 * case-insensitive form with a three-letter checksum. Tools accept either and
 * answer with 18, and an id's first three characters (its key prefix) name
 * its object, so any id resolves to an object through describe-global.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** Whether `value` is shaped like a Salesforce id (15 or 18 alphanumerics). */
export function isSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

/**
 * The 18-character form. Each 5-character chunk of the 15-character id
 * contributes one checksum character: bit i set when character i is an
 * uppercase letter.
 */
export function to18(id: string): string {
  if (!isSalesforceId(id)) return id;
  if (id.length === 18) return id;
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let bits = 0;
    for (let i = 0; i < 5; i += 1) {
      const ch = id.charAt(chunk * 5 + i);
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << i;
    }
    suffix += ALPHABET.charAt(bits);
  }
  return id + suffix;
}

/** Two ids name the same record whatever their length. */
export function sameId(a: string, b: string): boolean {
  return to18(a).toLowerCase() === to18(b).toLowerCase() && a.slice(0, 15) === b.slice(0, 15);
}

/** The key prefix (first three characters) that names an id's object. */
export function keyPrefix(id: string): string {
  return id.slice(0, 3);
}
