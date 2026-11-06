/**
 * What a preference save sends: only the fields that changed. PATCH
 * /api/preferences merges a patch into what is stored, so a form that
 * sends only its changes never overwrites a field something else (the
 * chat's voice menu, another tab) saved meanwhile, and sending the same
 * patch twice changes nothing the first did not.
 */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(after)) {
    const was: unknown = Reflect.get(before, key);
    const now: unknown = Reflect.get(after, key);
    if (JSON.stringify(was) !== JSON.stringify(now)) Object.assign(patch, { [key]: now });
  }
  return patch;
}
