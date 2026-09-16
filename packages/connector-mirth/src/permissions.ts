/**
 * What a person lets their LLM do on a connected Mirth instance, as a set
 * of named permissions a person recognises — "deploy channels", "delete
 * messages" — rather than a read / act / destructive ladder. Each mirth_*
 * tool names exactly one permission; a tool registers for a caller only
 * when some connected instance grants it, and every call re-checks the
 * permission on the instance it targets.
 *
 * These narrow what the tools may ATTEMPT with a credential the person
 * already holds. They never widen anything: the Mirth server's own roles
 * still judge every request by the connected account.
 *
 * The ids are stored on the connection row (`permissions text[]`), so
 * renaming one is a migration; adding one is a new entry here plus the
 * tools that name it.
 */

export const MIRTH_PERMISSIONS = [
  {
    id: 'channels.read',
    group: 'Channels',
    label: 'Read channels',
    description: 'List channels, read definitions, dashboard status, statistics, groups and tags.',
  },
  {
    id: 'channels.edit',
    group: 'Channels',
    label: 'Edit channels',
    description:
      'Create and update channel definitions, enable or disable them, set their initial state, and manage groups, tags, dependencies and metadata.',
  },
  {
    id: 'channels.deploy',
    group: 'Channels',
    label: 'Deploy and control channels',
    description: 'Deploy, undeploy, start, stop, pause, resume and halt channels and connectors.',
  },
  {
    id: 'channels.delete',
    group: 'Channels',
    label: 'Delete channels',
    description:
      'Remove channel definitions and their message stores. Permanent; confirmed on a card.',
  },
  {
    id: 'messages.read',
    group: 'Messages',
    label: 'Read messages',
    description:
      'Search and read message content and attachments. Message content may contain PHI.',
  },
  {
    id: 'messages.send',
    group: 'Messages',
    label: 'Send and reprocess messages',
    description: 'Send new messages through a channel, reprocess, import and export messages.',
  },
  {
    id: 'messages.delete',
    group: 'Messages',
    label: 'Delete messages and clear statistics',
    description:
      'Remove messages from a channel store and reset statistics. Permanent; confirmed on a card.',
  },
  {
    id: 'alerts.read',
    group: 'Alerts',
    label: 'Read alerts',
    description: 'List alerts and read their definitions and status.',
  },
  {
    id: 'alerts.edit',
    group: 'Alerts',
    label: 'Edit alerts',
    description: 'Create, update, enable and disable alerts.',
  },
  {
    id: 'alerts.delete',
    group: 'Alerts',
    label: 'Delete alerts',
    description: 'Remove alerts. Permanent; confirmed on a card.',
  },
  {
    id: 'code_templates.read',
    group: 'Code templates',
    label: 'Read code templates',
    description: 'List code template libraries and read templates and their code.',
  },
  {
    id: 'code_templates.edit',
    group: 'Code templates',
    label: 'Edit code templates',
    description: 'Create and update code templates and libraries.',
  },
  {
    id: 'code_templates.delete',
    group: 'Code templates',
    label: 'Delete code templates',
    description: 'Remove code templates and libraries. Permanent; confirmed on a card.',
  },
  {
    id: 'users.read',
    group: 'Users',
    label: 'Read users',
    description: 'List Mirth users and read their details and preferences.',
  },
  {
    id: 'users.edit',
    group: 'Users',
    label: 'Edit users',
    description: 'Create and update users, set passwords and preferences.',
  },
  {
    id: 'users.delete',
    group: 'Users',
    label: 'Delete users',
    description: 'Remove Mirth users. Permanent; confirmed on a card.',
  },
  {
    id: 'events.read',
    group: 'Events',
    label: 'Read the event log',
    description: "Read and export Mirth's server event (audit) log.",
  },
  {
    id: 'server.read',
    group: 'Server',
    label: 'Read server configuration',
    description:
      'Server info, settings, configuration map, global scripts, resources, extensions, system stats, license and the full configuration backup.',
  },
  {
    id: 'server.configure',
    group: 'Server',
    label: 'Configure the server',
    description:
      'Change server settings, the configuration map, global scripts, resources, drivers and extension settings; send test email.',
  },
  {
    id: 'server.restore',
    group: 'Server',
    label: 'Restore and maintain the server',
    description:
      'Restore a whole server configuration, uninstall extensions and run database maintenance tasks. Permanent; confirmed on a card.',
  },
] as const;

export type MirthPermission = (typeof MIRTH_PERMISSIONS)[number]['id'];

export const MIRTH_PERMISSION_IDS: readonly MirthPermission[] = MIRTH_PERMISSIONS.map(
  (permission) => permission.id
);

export function isMirthPermission(value: unknown): value is MirthPermission {
  return typeof value === 'string' && MIRTH_PERMISSION_IDS.some((id) => id === value);
}

/** The catalog entry, for labels in refusals and on the card. */
export function mirthPermission(id: MirthPermission) {
  const found = MIRTH_PERMISSIONS.find((permission) => permission.id === id);
  if (!found) throw new Error(`unknown Mirth permission ${id}`);
  return found;
}

/** The group order the card renders in. */
export const MIRTH_PERMISSION_GROUPS: readonly string[] = [
  ...new Set(MIRTH_PERMISSIONS.map((permission) => permission.group)),
];

/** Unknown values dropped, duplicates folded, catalog order kept. */
export function normalizePermissions(values: readonly unknown[]): MirthPermission[] {
  const wanted = new Set(values.filter(isMirthPermission));
  return MIRTH_PERMISSION_IDS.filter((id) => wanted.has(id));
}

/** Named starting points the card offers. */
export const MIRTH_PERMISSION_PRESETS: readonly {
  id: string;
  label: string;
  description: string;
  permissions: readonly MirthPermission[];
}[] = [
  {
    id: 'read',
    label: 'Read only',
    description: 'Every read permission, nothing that changes the server.',
    permissions: MIRTH_PERMISSION_IDS.filter((id) => id.endsWith('.read')),
  },
  {
    id: 'operate',
    label: 'Operate',
    description:
      'Read everything, deploy and control channels, send and reprocess messages, toggle alerts.',
    permissions: MIRTH_PERMISSION_IDS.filter(
      (id) =>
        id.endsWith('.read') ||
        id === 'channels.deploy' ||
        id === 'messages.send' ||
        id === 'alerts.edit'
    ),
  },
  {
    id: 'develop',
    label: 'Develop',
    description:
      'Operate, plus edit channels, code templates, alerts and server configuration — no deletes.',
    permissions: MIRTH_PERMISSION_IDS.filter(
      (id) => !id.endsWith('.delete') && id !== 'server.restore'
    ),
  },
  {
    id: 'all',
    label: 'Everything',
    description: 'Every permission, deletes and server restore included.',
    permissions: MIRTH_PERMISSION_IDS,
  },
];

/** What a new connection starts with when nothing was chosen. */
export const DEFAULT_MIRTH_PERMISSIONS: readonly MirthPermission[] = MIRTH_PERMISSION_IDS.filter(
  (id) => id.endsWith('.read')
);
