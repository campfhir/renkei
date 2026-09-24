/**
 * What a person lets their LLM do on a connected ADManager Plus instance,
 * as a set of named permissions a person recognises — the connector-mirth
 * shape (post-migration-107) from the start, never a read / act /
 * destructive ladder. Each admanager_* tool names exactly one permission;
 * a tool registers for a caller only when some connected instance grants
 * it, and every call re-checks the permission on the instance it targets.
 *
 * These narrow what the tools may ATTEMPT with a credential the person
 * already holds. They never widen anything: ADManager Plus's own
 * authtoken scope and the technician's own delegated rights still judge
 * every request.
 *
 * The ids are stored on the connection row (`permissions text[]`), so
 * renaming one is a migration; adding one is a new entry here plus the
 * tools that name it.
 */

export const ADMANAGER_PERMISSIONS = [
  {
    id: 'accounts.read',
    group: 'Accounts',
    label: 'Read accounts',
    description:
      'Look up a user’s attributes, account status and group membership, and search users. ' +
      'Needed before every other action here, to resolve and preview who is being acted on.',
  },
  {
    id: 'accounts.unlock',
    group: 'Accounts',
    label: 'Unlock accounts',
    description: 'Unlock a locked-out user account.',
  },
  {
    id: 'accounts.reset_password',
    group: 'Accounts',
    label: 'Reset passwords',
    description: 'Reset a user’s password, optionally forcing a change at next logon.',
  },
  {
    id: 'accounts.create',
    group: 'Accounts',
    label: 'Create accounts',
    description: 'Create a new user account, optionally from an ADManager Plus template.',
  },
  {
    id: 'accounts.edit',
    group: 'Accounts',
    label: 'Edit accounts',
    description:
      'Update an existing user’s attributes (department, title, phone, manager, description…), ' +
      'optionally reapplying a template.',
  },
  {
    id: 'groups.modify',
    group: 'Groups',
    label: 'Modify group membership',
    description:
      'Add or remove security-group membership, or copy another user’s group memberships onto a target.',
  },
] as const;

export type AdManagerPermission = (typeof ADMANAGER_PERMISSIONS)[number]['id'];

export const ADMANAGER_PERMISSION_IDS: readonly AdManagerPermission[] = ADMANAGER_PERMISSIONS.map(
  (permission) => permission.id
);

export function isAdManagerPermission(value: unknown): value is AdManagerPermission {
  return typeof value === 'string' && ADMANAGER_PERMISSION_IDS.some((id) => id === value);
}

/** The catalog entry, for labels in refusals and on the card. */
export function admanagerPermission(id: AdManagerPermission) {
  const found = ADMANAGER_PERMISSIONS.find((permission) => permission.id === id);
  if (!found) throw new Error(`unknown ADManager Plus permission ${id}`);
  return found;
}

/** The group order the card renders in. */
export const ADMANAGER_PERMISSION_GROUPS: readonly string[] = [
  ...new Set(ADMANAGER_PERMISSIONS.map((permission) => permission.group)),
];

/** Unknown values dropped, duplicates folded, catalog order kept. */
export function normalizePermissions(values: readonly unknown[]): AdManagerPermission[] {
  const wanted = new Set(values.filter(isAdManagerPermission));
  return ADMANAGER_PERMISSION_IDS.filter((id) => wanted.has(id));
}

/** Named starting points the card offers. */
export const ADMANAGER_PERMISSION_PRESETS: readonly {
  id: string;
  label: string;
  description: string;
  permissions: readonly AdManagerPermission[];
}[] = [
  {
    id: 'read',
    label: 'Read only',
    description: 'Look up accounts and group membership; nothing that changes AD.',
    permissions: ['accounts.read'],
  },
  {
    id: 'helpdesk',
    label: 'Helpdesk',
    description: 'Read, plus the two highest-volume service-desk asks: unlock and reset password.',
    permissions: ['accounts.read', 'accounts.unlock', 'accounts.reset_password'],
  },
  {
    id: 'provisioning',
    label: 'Provisioning',
    description: 'Read, plus create/edit accounts and manage group membership.',
    permissions: ['accounts.read', 'accounts.create', 'accounts.edit', 'groups.modify'],
  },
  {
    id: 'all',
    label: 'Everything',
    description: 'Every permission.',
    permissions: ADMANAGER_PERMISSION_IDS,
  },
];

/** What a new connection starts with when nothing was chosen. */
export const DEFAULT_ADMANAGER_PERMISSIONS: readonly AdManagerPermission[] = ['accounts.read'];
