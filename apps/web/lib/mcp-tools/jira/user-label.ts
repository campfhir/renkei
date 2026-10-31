/**
 * How a preview card names a person it was given by accountId.
 *
 * An email or a name is already something a person recognises, so it is left
 * alone. An accountId is a handle for the call, never wording: it is read
 * back as the person's display name, and when that cannot be read the card
 * says `generic` instead.
 */

import { looksLikeAccountId } from './resolve-user';

export async function previewUserLabel(
  readUser: (accountId: string) => Promise<unknown>,
  raw: string,
  generic = 'the selected person'
): Promise<string> {
  const value = raw.trim();
  if (!looksLikeAccountId(value)) return value;
  try {
    const found = await readUser(value);
    const name =
      typeof found === 'object' && found !== null && 'displayName' in found
        ? found.displayName
        : '';
    return typeof name === 'string' && name ? name : generic;
  } catch {
    return generic;
  }
}
