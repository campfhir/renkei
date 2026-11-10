/**
 * Preview cards for Jira's act tools that have no hand-written one
 * (issue create/update/delete/move have their own, in jira/write.ts).
 */

import type { PreviewBuilder } from './card';
import { clip, count, named, nameOr, ref, record, show, strings, text, yes } from './card';

const JIRA = 'Jira';
const issue = (key: string) => ref(key, undefined, undefined);

const COMMENT = [{ key: 'comment', label: 'Comment', multiline: true }];

export const JIRA_PREVIEWS: Record<string, PreviewBuilder> = {
  jira_request_admin_change: (args) => ({
    verb: 'Request',
    icon: 'doc',
    title: text(args.title) || 'Ask for a change to Jira',
    subtitle: JIRA,
    confirmLabel: 'Send the request',
    body: {
      kind: 'change',
      subject: ref(text(args.title) || 'A change request', 'Request'),
      rows: [
        { label: 'Asking for', value: clip(text(args.description), 400), block: true },
        ...(text(args.reason) ? [{ label: 'Why', value: clip(text(args.reason), 200) }] : []),
      ],
      notes: [
        'Nothing changes in Jira. Operators who administer Jira are told; one builds it as a proposal and approves it, or declines it with a reason.',
      ],
    },
  }),

  jira_add_comment: (args) => ({
    verb: 'Comment',
    icon: 'comment',
    title: `Comment on ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Post comment',
    editable: COMMENT,
    body: {
      kind: 'comment',
      mode: 'add',
      on: issue(text(args.issueKey)),
      bodyKey: 'comment',
      body: text(args.comment),
    },
  }),

  jira_update_comment: (args, names) => ({
    verb: 'Edit',
    icon: 'comment',
    title: `Edit a comment on ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Save comment',
    editable: COMMENT,
    body: {
      kind: 'comment',
      mode: 'edit',
      on: issue(text(args.issueKey)),
      commentId: text(args.commentId),
      commentLabel: named(names, 'comment', args.commentId),
      bodyKey: 'comment',
      body: text(args.comment),
    },
  }),

  jira_delete_comment: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete a comment on ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Delete comment',
    body: {
      kind: 'comment',
      mode: 'delete',
      on: issue(text(args.issueKey)),
      commentId: text(args.commentId),
      commentLabel: named(names, 'comment', args.commentId),
    },
  }),

  jira_transition_issue: (args) => ({
    verb: 'Move',
    icon: 'arrow',
    title: `Move ${text(args.issueKey)} to ${text(args.transitionName)}`,
    subtitle: JIRA,
    confirmLabel: 'Move issue',
    editable: args.comment === undefined ? [] : COMMENT,
    body: {
      kind: 'transition',
      subject: issue(text(args.issueKey)),
      field: 'Workflow transition',
      to: text(args.transitionName),
      noteKey: 'comment',
      note: text(args.comment),
    },
  }),

  jira_bulk_transition_issues: (args) => ({
    verb: 'Move many',
    tone: 'caution',
    icon: 'arrow',
    title: `Move every matching issue to ${text(args.transitionName)}`,
    subtitle: JIRA,
    confirmLabel: 'Move them all',
    body: {
      kind: 'transition',
      query: text(args.jql),
      field: 'Workflow transition',
      to: text(args.transitionName),
    },
  }),

  jira_bulk_update_issues: (args) => ({
    verb: 'Update many',
    tone: 'caution',
    icon: 'gear',
    title: 'Update every issue matching a search',
    subtitle: JIRA,
    confirmLabel: 'Update them all',
    body: {
      kind: 'change',
      subject: ref('Issues matching', text(args.jql)),
      rows: Object.entries(record(args.fields)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: ['Every issue the search returns is changed, not only the ones you have seen.'],
    },
  }),

  jira_log_work: (args) => worklog(args),
  jira_create_worklog: (args) => worklog(args),

  jira_delete_worklog: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete a worklog on ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Delete worklog',
    body: {
      kind: 'worklog',
      mode: 'delete',
      on: issue(text(args.issueKey)),
      worklogId: text(args.worklogId),
      worklogLabel: named(names, 'worklog', args.worklogId),
    },
  }),

  jira_add_attachment: (args) => {
    const name =
      text(args.filename) ||
      text(record(args.driveItem).name) ||
      text(record(args.outlookAttachment).name) ||
      'A file';
    const from = args.driveItem
      ? 'from OneDrive or SharePoint'
      : args.outlookAttachment
        ? 'from an email'
        : '';
    return {
      verb: 'Attach',
      icon: 'upload',
      title: `Attach ${name} to ${text(args.issueKey)}`,
      subtitle: JIRA,
      confirmLabel: 'Attach file',
      body: {
        kind: 'fileop',
        mode: 'attach',
        items: [{ name, type: 'attachment', ...(from ? { path: from } : {}) }],
        to: { name: text(args.issueKey) },
      },
    };
  },

  jira_create_issue_link: (args) => ({
    verb: 'Link',
    icon: 'link',
    title: `Link ${text(args.fromIssueKey)} to ${text(args.toIssueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Create link',
    body: {
      kind: 'link',
      mode: 'create',
      from: issue(text(args.fromIssueKey)),
      relation: text(args.linkType),
      to: issue(text(args.toIssueKey)),
    },
  }),

  jira_create_remote_link: (args) => ({
    verb: 'Link',
    icon: 'link',
    title: `Add a link to ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Add link',
    body: {
      kind: 'link',
      mode: 'create',
      from: issue(text(args.issueKey)),
      relation: text(args.relationship) || 'links to',
      url: { href: text(args.url), title: text(args.title) },
    },
  }),

  jira_delete_issue_link: (args, names) => ({
    verb: 'Unlink',
    tone: 'danger',
    icon: 'link',
    title: 'Remove a link between two issues',
    subtitle: JIRA,
    confirmLabel: 'Remove link',
    body: {
      kind: 'link',
      mode: 'delete',
      relation: '',
      linkId: text(args.linkId),
      linkLabel: named(names, 'link', args.linkId),
    },
  }),

  jira_create_sprint: (args, names) => ({
    verb: 'Create',
    icon: 'sprint',
    title: `Create the sprint ${text(args.name)}`,
    subtitle: JIRA,
    confirmLabel: 'Create sprint',
    body: {
      kind: 'sprint',
      mode: 'create',
      sprint: {
        name: text(args.name),
        board: named(names, 'board', args.boardId),
        start: text(args.startDate),
        end: text(args.endDate),
        goal: text(args.goal),
      },
    },
  }),

  jira_complete_sprint: (args, names) => ({
    verb: 'Complete',
    tone: 'caution',
    icon: 'sprint',
    title: `Complete ${nameOr(names, 'sprint', args.sprintId, 'the sprint')}`,
    subtitle: JIRA,
    confirmLabel: 'Complete sprint',
    body: {
      kind: 'sprint',
      mode: 'complete',
      sprint: {
        id: text(args.sprintId),
        name: named(names, 'sprint', args.sprintId),
        board: named(names, 'board', args.boardId),
      },
    },
  }),

  jira_move_issue_to_sprint: (args, names) => ({
    verb: 'Move',
    icon: 'sprint',
    title: `Move ${text(args.issueKey)} into ${nameOr(names, 'sprint', args.sprintId, 'the sprint')}`,
    subtitle: JIRA,
    confirmLabel: 'Move to sprint',
    body: {
      kind: 'sprint',
      mode: 'move',
      sprint: { id: text(args.sprintId), name: named(names, 'sprint', args.sprintId) },
      issues: [text(args.issueKey)],
    },
  }),

  jira_remove_issue_from_sprint: (args) => ({
    verb: 'Remove',
    icon: 'sprint',
    title: `Take ${text(args.issueKey)} out of its sprint`,
    subtitle: JIRA,
    confirmLabel: 'Move to backlog',
    body: { kind: 'sprint', mode: 'remove', issues: [text(args.issueKey)] },
  }),

  jira_bulk_move_sprint_issues: (args, names) => {
    const keys = strings(args.issueKeys);
    const sprint = text(args.sprintId);
    return {
      verb: 'Move many',
      icon: 'sprint',
      title: sprint
        ? `Move ${count(keys.length, 'issue')} into ${nameOr(names, 'sprint', sprint, 'the sprint')}`
        : `Move ${count(keys.length, 'issue')} out of their sprints`,
      subtitle: JIRA,
      confirmLabel: 'Move issues',
      body: {
        kind: 'sprint',
        mode: 'move',
        ...(sprint ? { sprint: { id: sprint, name: named(names, 'sprint', sprint) } } : {}),
        issues: keys,
      },
    };
  },

  jira_create_component: (args) => ({
    verb: 'Create',
    icon: 'tag',
    title: `Create the component ${text(args.name)}`,
    subtitle: `${JIRA} · ${text(args.projectKey)}`,
    confirmLabel: 'Create component',
    body: {
      kind: 'change',
      subject: ref(text(args.name), 'Component', text(args.projectKey)),
      rows: [
        ...(text(args.description)
          ? [{ label: 'Description', value: text(args.description) }]
          : []),
        ...(text(args.lead) ? [{ label: 'Lead', value: text(args.lead) }] : []),
      ],
    },
  }),

  jira_delete_component: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete ${nameOr(names, 'component', args.componentId, 'a component')}`,
    subtitle: JIRA,
    confirmLabel: 'Delete component',
    body: {
      kind: 'change',
      subject: ref(nameOr(names, 'component', args.componentId, 'The component'), 'Component'),
      rows: text(args.moveIssuesTo)
        ? [
            {
              label: 'Its issues move to',
              value: nameOr(names, 'component', args.moveIssuesTo, 'another component'),
            },
          ]
        : [],
      notes: [
        text(args.moveIssuesTo)
          ? 'Issues that use it are switched to the other component.'
          : 'It is taken off every issue that uses it.',
      ],
    },
  }),

  jira_create_filter: (args) => ({
    verb: 'Save',
    icon: 'tag',
    title: `Save the filter ${text(args.name)}`,
    subtitle: JIRA,
    confirmLabel: 'Save filter',
    body: {
      kind: 'change',
      subject: ref(text(args.name), 'Saved filter'),
      rows: [
        { label: 'JQL', value: clip(text(args.jql), 800), block: true },
        ...(text(args.description)
          ? [{ label: 'Description', value: text(args.description) }]
          : []),
        ...(args.favourite === undefined
          ? []
          : [{ label: 'Starred', value: yes(args.favourite) ? 'Yes' : 'No' }]),
      ],
    },
  }),

  jira_delete_filter: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete ${nameOr(names, 'filter', args.filterId, 'a saved filter')}`,
    subtitle: JIRA,
    confirmLabel: 'Delete filter',
    body: {
      kind: 'change',
      subject: ref(nameOr(names, 'filter', args.filterId, 'The filter'), 'Saved filter'),
      rows: [],
      notes: ['Boards and dashboards that use it stop showing its results.'],
    },
  }),

  jira_create_version: (args) => ({
    verb: 'Create',
    icon: 'flag',
    title: `Create the version ${text(args.name)}`,
    subtitle: `${JIRA} · ${text(args.projectKey)}`,
    confirmLabel: 'Create version',
    body: {
      kind: 'change',
      subject: ref(text(args.name), 'Version', text(args.projectKey)),
      rows: [
        ...(text(args.description)
          ? [{ label: 'Description', value: text(args.description) }]
          : []),
        ...(text(args.startDate) ? [{ label: 'Starts', value: text(args.startDate) }] : []),
        ...(text(args.releaseDate) ? [{ label: 'Releases', value: text(args.releaseDate) }] : []),
        ...(args.released === undefined
          ? []
          : [{ label: 'Already released', value: yes(args.released) ? 'Yes' : 'No' }]),
      ],
    },
  }),

  jira_watch_project: (args) => watch(args, true),
  jira_unwatch_project: (args) => watch(args, false),
};

function worklog(args: Record<string, unknown>) {
  const spec = {
    verb: 'Log time',
    icon: 'clock' as const,
    title: `Log ${text(args.timeSpent)} on ${text(args.issueKey)}`,
    subtitle: JIRA,
    confirmLabel: 'Log work',
    editable:
      args.comment === undefined
        ? []
        : [{ key: 'comment', label: 'What you worked on', multiline: true }],
    body: {
      kind: 'worklog' as const,
      mode: 'log' as const,
      on: issue(text(args.issueKey)),
      duration: text(args.timeSpent),
      ...(text(args.started) ? { started: text(args.started) } : {}),
      bodyKey: 'comment',
      body: text(args.comment),
    },
  };
  return spec;
}

function watch(args: Record<string, unknown>, on: boolean) {
  return {
    verb: on ? 'Watch' : 'Unwatch',
    icon: 'bell' as const,
    title: `${on ? 'Watch' : 'Stop watching'} the ${text(args.projectKey)} project`,
    subtitle: JIRA,
    confirmLabel: on ? 'Watch project' : 'Stop watching',
    body: {
      kind: 'access' as const,
      mode: on ? ('watch' as const) : ('unwatch' as const),
      who: [],
      on: ref(text(args.projectKey), 'Project'),
      details: [
        {
          label: 'You will',
          value: on
            ? 'get a notification for new and changed issues'
            : 'stop getting notifications for it',
        },
      ],
    },
  };
}
