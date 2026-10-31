/**
 * Preview cards for Jira Service Management: requests, customers, and the
 * Ops alert, schedule and maintenance acts (jsm_create_request has its own
 * hand-written card in jira-service-management/jsm.ts).
 */

import type { Names, PreviewBuilder } from './card';
import { clip, count, named, nameOr, people, ref, strings, text } from './card';

const JSM = 'Jira Service Management';
const OPS = 'JSM Ops';

const request = (key: string) => ref(key, 'Request');

/** A person as the card says it: an email is already readable; an account id becomes a name. */
const who = (names: Names, value: unknown, generic = 'This person'): string =>
  text(value).includes('@') ? text(value) : nameOr(names, 'user', value, generic);

const desk = (names: Names, id: unknown) =>
  ref(nameOr(names, 'desk', id, 'The service desk'), 'Service desk');

/** `the alert “CPU high”`, or `the alert` when it could not be read. */
const alertName = (names: Names, id: unknown): string =>
  named(names, 'alert', id) ? `the alert “${named(names, 'alert', id)}”` : 'the alert';

/** Names for a list of ids, or a count when any is unknown ("2 integrations"). */
function nameList(names: Names, kind: string, ids: string[], noun: string, plural: string): string {
  const found = ids.map((id) => named(names, kind, id));
  return found.every(Boolean) ? found.join(', ') : count(ids.length, noun, plural);
}

export const JSM_PREVIEWS: Record<string, PreviewBuilder> = {
  jsm_add_request_comment: (args) => {
    const internal = args.isInternal === true;
    return {
      verb: internal ? 'Internal note' : 'Reply',
      tone: internal ? 'caution' : 'neutral',
      icon: 'comment',
      title: internal
        ? `Add an internal note to ${text(args.issueKey)}`
        : `Reply to the customer on ${text(args.issueKey)}`,
      subtitle: JSM,
      confirmLabel: internal ? 'Add note' : 'Send reply',
      editable: [{ key: 'comment', label: internal ? 'Note' : 'Reply', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: request(text(args.issueKey)),
        bodyKey: 'comment',
        body: text(args.comment),
        badges: internal
          ? ['Internal note', 'Not visible to the customer']
          : ['Public reply', 'The customer is notified'],
      },
    };
  },

  jsm_transition_request: (args) => ({
    verb: 'Move',
    icon: 'arrow',
    title: `Move ${text(args.issueKey)} to ${text(args.transitionName)}`,
    subtitle: JSM,
    confirmLabel: 'Move request',
    body: {
      kind: 'transition',
      subject: request(text(args.issueKey)),
      field: 'Workflow transition',
      to: text(args.transitionName),
    },
  }),

  jsm_add_request_participant: (args, names) => ({
    verb: 'Add',
    icon: 'user',
    title: `Add a participant to ${text(args.issueKey)}`,
    subtitle: JSM,
    confirmLabel: 'Add participant',
    body: {
      kind: 'access',
      mode: 'add',
      who: [
        {
          name: nameOr(names, 'user', args.accountId, 'This person'),
          detail: 'Atlassian account',
          kind: 'user',
        },
      ],
      level: 'Participant',
      on: request(text(args.issueKey)),
      details: [{ label: 'They can', value: 'see the request and comment on it in the portal' }],
    },
  }),

  jsm_remove_request_participant: (args, names) => ({
    verb: 'Remove',
    tone: 'danger',
    icon: 'user',
    title: `Remove a participant from ${text(args.issueKey)}`,
    subtitle: JSM,
    confirmLabel: 'Remove participant',
    body: {
      kind: 'access',
      mode: 'remove',
      who: [
        {
          name: nameOr(names, 'user', args.accountId, 'This person'),
          detail: 'Atlassian account',
          kind: 'user',
        },
      ],
      level: 'Participant',
      on: request(text(args.issueKey)),
    },
  }),

  jsm_add_customer_to_servicedesk: (args, names) => ({
    verb: 'Add',
    icon: 'user',
    title: `Add ${who(names, args.user)} as a customer`,
    subtitle: JSM,
    confirmLabel: 'Add customer',
    body: {
      kind: 'access',
      mode: 'add',
      who: [{ name: who(names, args.user), kind: 'user' }],
      level: 'Customer',
      on: desk(names, args.serviceDeskId),
      details: [{ label: 'They can', value: 'raise requests in this service desk’s portal' }],
    },
  }),

  jsm_remove_customer_from_servicedesk: (args, names) => ({
    verb: 'Remove',
    tone: 'danger',
    icon: 'user',
    title: `Remove ${who(names, args.user)} as a customer`,
    subtitle: JSM,
    confirmLabel: 'Remove customer',
    body: {
      kind: 'access',
      mode: 'remove',
      who: [{ name: who(names, args.user), kind: 'user' }],
      level: 'Customer',
      on: desk(names, args.serviceDeskId),
    },
  }),

  jsm_invite_customers_to_servicedesk: (args, names) => {
    const emails = strings(args.emails);
    return {
      verb: 'Invite',
      icon: 'mail',
      title: `Invite ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to ${named(names, 'desk', args.serviceDeskId) || 'a service desk'}`,
      subtitle: JSM,
      confirmLabel: 'Send invitations',
      body: {
        kind: 'access',
        mode: 'invite',
        who: people(emails, 'email'),
        level: 'Customer',
        on: desk(names, args.serviceDeskId),
        details: [{ label: 'Each gets', value: 'an email invitation to the portal' }],
      },
    };
  },

  jsm_create_customer: (args) => ({
    verb: 'Create',
    icon: 'user',
    title: `Create a customer account for ${text(args.email)}`,
    subtitle: JSM,
    confirmLabel: 'Create customer',
    body: {
      kind: 'access',
      mode: 'add',
      who: [
        {
          name: text(args.displayName) || text(args.email),
          detail: text(args.displayName) ? text(args.email) : '',
          kind: 'email',
        },
      ],
      level: 'Customer account',
      on: ref('Customer accounts', undefined, JSM),
    },
  }),

  jsm_ops_acknowledge_alert: (args, names) => ({
    verb: 'Acknowledge',
    icon: 'bell',
    title: `Acknowledge ${alertName(names, args.alertId)}`,
    subtitle: OPS,
    confirmLabel: 'Acknowledge',
    body: {
      kind: 'transition',
      subject: ref(nameOr(names, 'alert', args.alertId, 'The alert'), 'Alert'),
      field: 'Alert',
      to: 'Acknowledged',
    },
  }),

  jsm_ops_close_alert: (args, names) => ({
    verb: 'Close',
    tone: 'caution',
    icon: 'bell',
    title: `Close ${alertName(names, args.alertId)}`,
    subtitle: OPS,
    confirmLabel: 'Close alert',
    body: {
      kind: 'transition',
      subject: ref(nameOr(names, 'alert', args.alertId, 'The alert'), 'Alert'),
      field: 'Alert',
      to: 'Closed',
    },
  }),

  jsm_ops_create_override: (args, names) => ({
    verb: 'Override',
    icon: 'calendar',
    title: 'Add an on-call override',
    subtitle: OPS,
    confirmLabel: 'Add override',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(
        nameOr(names, 'schedule', args.scheduleId, 'The on-call schedule'),
        'On-call schedule'
      ),
      rows: [
        {
          label: 'On call',
          value: text(args.responderAccountId) ? who(names, args.responderAccountId) : 'You',
        },
        { label: 'From', value: text(args.startDate) },
        { label: 'Until', value: text(args.endDate) },
        ...(strings(args.rotationIds).length > 0
          ? [
              {
                label: 'Rotations',
                value: nameList(
                  names,
                  'rotation',
                  strings(args.rotationIds),
                  'rotation',
                  'rotations'
                ),
              },
            ]
          : [{ label: 'Rotations', value: 'All of them' }]),
      ],
      notes: ['Whoever was on call in that window is replaced for its duration.'],
    },
  }),

  jsm_ops_delete_override: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: 'Delete an on-call override',
    subtitle: OPS,
    confirmLabel: 'Delete override',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(
        nameOr(names, 'schedule', args.scheduleId, 'The on-call schedule'),
        'On-call schedule'
      ),
      rows: [
        {
          label: 'Override',
          value: nameOr(names, 'override', args.alias, 'The selected override'),
        },
      ],
      notes: ['The schedule goes back to its rotations for that window.'],
    },
  }),

  jsm_ops_update_rotation: (args, names) => ({
    verb: 'Change',
    tone: 'caution',
    icon: 'calendar',
    title: 'Change an on-call rotation',
    subtitle: OPS,
    confirmLabel: 'Change rotation',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(
        nameOr(names, 'rotation', args.rotationId, 'The rotation'),
        'Rotation',
        named(names, 'schedule', args.scheduleId)
      ),
      rows: [
        ...(text(args.name) ? [{ label: 'Name', value: text(args.name) }] : []),
        ...(text(args.type)
          ? [
              {
                label: 'Repeats',
                value: `${text(args.type)}${args.length ? `, every ${text(args.length)}` : ''}`,
              },
            ]
          : []),
        ...(text(args.startDate) ? [{ label: 'Starts', value: text(args.startDate) }] : []),
        ...(text(args.endDate) ? [{ label: 'Ends', value: text(args.endDate) }] : []),
        ...(strings(args.participantAccountIds).length > 0
          ? [
              {
                label: 'Participants',
                value: strings(args.participantAccountIds)
                  .map((accountId) => who(names, accountId, 'Someone'))
                  .join(', '),
              },
            ]
          : []),
      ],
      notes: ['Only the fields shown change; the rest of the rotation is left as it is.'],
    },
  }),

  jsm_ops_create_maintenance: (args, names) => ({
    verb: 'Schedule',
    tone: 'caution',
    icon: 'gear',
    title: 'Schedule a maintenance window',
    subtitle: OPS,
    confirmLabel: 'Schedule window',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(clip(text(args.description) || 'Maintenance window', 80), 'Maintenance'),
      rows: [
        { label: 'From', value: text(args.startDate) },
        { label: 'Until', value: text(args.endDate) },
        ...(strings(args.integrationIds).length > 0
          ? [
              {
                label: 'Integrations',
                value: nameList(
                  names,
                  'integration',
                  strings(args.integrationIds),
                  'integration',
                  'integrations'
                ),
              },
            ]
          : []),
        ...(strings(args.policyIds).length > 0
          ? [
              {
                label: 'Policies',
                value: count(strings(args.policyIds).length, 'alert policy', 'alert policies'),
              },
            ]
          : []),
      ],
      notes: ['Alerts from what it covers are not raised while the window is open.'],
    },
  }),

  jsm_ops_cancel_maintenance: (args, names) => ({
    verb: 'Cancel',
    tone: 'danger',
    icon: 'cross',
    title: 'Cancel a maintenance window',
    subtitle: OPS,
    confirmLabel: 'Cancel window',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(
        nameOr(names, 'maintenance', args.maintenanceId, 'The maintenance window'),
        'Maintenance'
      ),
      rows: [],
      notes: ['Alerts from what it covered start being raised again.'],
    },
  }),
};
