/**
 * Preview cards for Jira Service Management: requests, customers, and the
 * Ops alert, schedule and maintenance acts (jsm_create_request has its own
 * hand-written card in jira-service-management/jsm.ts).
 */

import type { PreviewBuilder } from './card';
import { clip, people, ref, strings, text } from './card';

const JSM = 'Jira Service Management';
const OPS = 'JSM Ops';

const request = (key: string) => ref(key, 'Request');

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

  jsm_add_request_participant: (args) => ({
    verb: 'Add',
    icon: 'user',
    title: `Add a participant to ${text(args.issueKey)}`,
    subtitle: JSM,
    confirmLabel: 'Add participant',
    body: {
      kind: 'access',
      mode: 'add',
      who: [{ name: text(args.accountId), detail: 'Atlassian account', kind: 'user' }],
      level: 'Participant',
      on: request(text(args.issueKey)),
      details: [{ label: 'They can', value: 'see the request and comment on it in the portal' }],
    },
  }),

  jsm_remove_request_participant: (args) => ({
    verb: 'Remove',
    tone: 'danger',
    icon: 'user',
    title: `Remove a participant from ${text(args.issueKey)}`,
    subtitle: JSM,
    confirmLabel: 'Remove participant',
    body: {
      kind: 'access',
      mode: 'remove',
      who: [{ name: text(args.accountId), detail: 'Atlassian account', kind: 'user' }],
      level: 'Participant',
      on: request(text(args.issueKey)),
    },
  }),

  jsm_add_customer_to_servicedesk: (args) => ({
    verb: 'Add',
    icon: 'user',
    title: `Add ${text(args.user)} as a customer`,
    subtitle: JSM,
    confirmLabel: 'Add customer',
    body: {
      kind: 'access',
      mode: 'add',
      who: [{ name: text(args.user), kind: 'user' }],
      level: 'Customer',
      on: ref(text(args.serviceDeskId), 'Service desk'),
      details: [{ label: 'They can', value: 'raise requests in this service desk’s portal' }],
    },
  }),

  jsm_remove_customer_from_servicedesk: (args) => ({
    verb: 'Remove',
    tone: 'danger',
    icon: 'user',
    title: `Remove ${text(args.user)} as a customer`,
    subtitle: JSM,
    confirmLabel: 'Remove customer',
    body: {
      kind: 'access',
      mode: 'remove',
      who: [{ name: text(args.user), kind: 'user' }],
      level: 'Customer',
      on: ref(text(args.serviceDeskId), 'Service desk'),
    },
  }),

  jsm_invite_customers_to_servicedesk: (args) => {
    const emails = strings(args.emails);
    return {
      verb: 'Invite',
      icon: 'mail',
      title: `Invite ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to a service desk`,
      subtitle: JSM,
      confirmLabel: 'Send invitations',
      body: {
        kind: 'access',
        mode: 'invite',
        who: people(emails, 'email'),
        level: 'Customer',
        on: ref(text(args.serviceDeskId), 'Service desk'),
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

  jsm_ops_acknowledge_alert: (args) => ({
    verb: 'Acknowledge',
    icon: 'bell',
    title: `Acknowledge alert ${text(args.alertId)}`,
    subtitle: OPS,
    confirmLabel: 'Acknowledge',
    body: {
      kind: 'transition',
      subject: ref(text(args.alertId), 'Alert'),
      field: 'Alert',
      to: 'Acknowledged',
    },
  }),

  jsm_ops_close_alert: (args) => ({
    verb: 'Close',
    tone: 'caution',
    icon: 'bell',
    title: `Close alert ${text(args.alertId)}`,
    subtitle: OPS,
    confirmLabel: 'Close alert',
    body: {
      kind: 'transition',
      subject: ref(text(args.alertId), 'Alert'),
      field: 'Alert',
      to: 'Closed',
    },
  }),

  jsm_ops_create_override: (args) => ({
    verb: 'Override',
    icon: 'calendar',
    title: 'Add an on-call override',
    subtitle: OPS,
    confirmLabel: 'Add override',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(text(args.scheduleId), 'On-call schedule'),
      rows: [
        { label: 'On call', value: text(args.responderAccountId) || 'You' },
        { label: 'From', value: text(args.startDate) },
        { label: 'Until', value: text(args.endDate) },
        ...(strings(args.rotationIds).length > 0
          ? [{ label: 'Rotations', value: strings(args.rotationIds).join(', ') }]
          : [{ label: 'Rotations', value: 'All of them' }]),
      ],
      notes: ['Whoever was on call in that window is replaced for its duration.'],
    },
  }),

  jsm_ops_delete_override: (args) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: 'Delete an on-call override',
    subtitle: OPS,
    confirmLabel: 'Delete override',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(text(args.scheduleId), 'On-call schedule'),
      rows: [{ label: 'Override', value: text(args.alias) }],
      notes: ['The schedule goes back to its rotations for that window.'],
    },
  }),

  jsm_ops_update_rotation: (args) => ({
    verb: 'Change',
    tone: 'caution',
    icon: 'calendar',
    title: 'Change an on-call rotation',
    subtitle: OPS,
    confirmLabel: 'Change rotation',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(text(args.rotationId), 'Rotation', text(args.scheduleId)),
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
          ? [{ label: 'Participants', value: strings(args.participantAccountIds).join(', ') }]
          : []),
      ],
      notes: ['Only the fields shown change; the rest of the rotation is left as it is.'],
    },
  }),

  jsm_ops_create_maintenance: (args) => ({
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
          ? [{ label: 'Integrations', value: strings(args.integrationIds).join(', ') }]
          : []),
        ...(strings(args.policyIds).length > 0
          ? [{ label: 'Policies', value: strings(args.policyIds).join(', ') }]
          : []),
      ],
      notes: ['Alerts from what it covers are not raised while the window is open.'],
    },
  }),

  jsm_ops_cancel_maintenance: (args) => ({
    verb: 'Cancel',
    tone: 'danger',
    icon: 'cross',
    title: 'Cancel a maintenance window',
    subtitle: OPS,
    confirmLabel: 'Cancel window',
    confirmWith: { confirm: true },
    body: {
      kind: 'change',
      subject: ref(text(args.maintenanceId), 'Maintenance'),
      rows: [],
      notes: ['Alerts from what it covered start being raised again.'],
    },
  }),
};
