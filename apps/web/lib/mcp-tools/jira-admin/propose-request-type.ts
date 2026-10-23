/**
 * jira_admin_propose_request_type — a request type for a service project,
 * proposed as a change request the person applies from Renkei's review
 * page (lib/jira-admin/request-type.ts). Nothing changes in Jira here.
 *
 * Two grants in one tool (jsm-access.ts says why): the space and its work
 * types are read on the Jira Administration grant, the service desk and
 * its request types on the Jira Service Management grant — and the apply
 * route sends the create on the JSM grant. Registered only when the
 * person holds both with the scopes each needs (index.ts).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, rec, records, str } from './client';
import { jsmAccessFromContext } from './jsm-access';
import { reviewPrefix } from './review-link';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
} from '@/lib/jira-admin/change-requests';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import {
  REQUEST_TYPE_KIND,
  readRequestTypes,
  requestTypeTitle,
  type RequestTypePayload,
} from '@/lib/jira-admin/request-type';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export async function registerProposeRequestTypeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_propose_request_type',
    {
      title: 'Jira Admin · Act — Propose a request type for a service project',
      description:
        'Propose a request type on a service project’s customer portal: its name, the work ' +
        'type it is backed by (one the project has — jira_admin_propose_work_type adds one), ' +
        'and an optional description and help text. Jira gives it the headset icon, the work ' +
        'type’s fields and no portal group, so it stays hidden on the portal until an admin ' +
        'groups it in Project settings; its icon, fields, required fields and portal defaults ' +
        'can only be set there — Jira’s API has no way to. Applying runs on the user’s Jira ' +
        'Service Management connection. Nothing changes in Jira: this saves a change request, ' +
        'and the user applies it from the Renkei review page linked in the result (it expires ' +
        `in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        space: z.string().min(1).describe('The service project’s key, e.g. HELP'),
        name: z.string().min(1).max(255).describe('The request type’s name, e.g. Report an outage'),
        workType: z
          .string()
          .min(1)
          .max(60)
          .describe('The work type it is backed by, e.g. Incident'),
        description: z
          .string()
          .max(1000)
          .describe('Shown to customers under the name on the portal')
          .optional(),
        helpText: z
          .string()
          .max(1000)
          .describe('Shown to customers on the request form')
          .optional(),
        reason: z
          .string()
          .max(1000)
          .describe('Why — shown to the user on the review page')
          .optional(),
        replaces: z
          .string()
          .describe(
            'The id of a pending change request of this user’s that this one supersedes; it is ' +
              'cancelled once this one is saved'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const jsm = jsmAccessFromContext(context);
      if (typeof jsm === 'string') return errText(jsm);
      if (jsm.cloudId !== access.cloudId) {
        return errText(
          'Your Jira Service Management connection is on a different Jira site than your Jira ' +
            'Administration connection, so Renkei cannot set up a request type. Reconnect one ' +
            'of them to the same site.'
        );
      }

      const spaceRef = text(args.space).toUpperCase();
      const name = text(args.name);
      const workTypeRef = text(args.workType);
      if (!spaceRef) return errText('space is required');
      if (!name) return errText('name is required');
      if (!workTypeRef) return errText('workType is required');
      const notes: string[] = [];

      // The space, on the admin grant: a service project with that work type.
      const project = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceRef)}`
      );
      if (!project.ok) return errText(`Space ${spaceRef}: ${project.error}`);
      const spaceRecord = rec(project.body);
      const key = str(spaceRecord.key) || spaceRef;
      if (str(spaceRecord.projectTypeKey) !== 'service_desk') {
        return errText(
          `${key} is not a service project, so it has no customer portal or request types.`
        );
      }
      if (spaceRecord.simplified === true || spaceRecord.style === 'next-gen') {
        return errText(
          `${key} is team-managed: its request types are made by adding work types inside the ` +
            'space, which jira_admin_propose_work_type does not cover.'
        );
      }
      const spaceTypes = records(spaceRecord.issueTypes).map((type) => ({
        id: str(type.id),
        name: str(type.name),
        subtask: type.subtask === true,
      }));
      const workType = spaceTypes.find(
        (type) => type.name.toLowerCase() === workTypeRef.toLowerCase()
      );
      if (!workType) {
        return errText(
          `${key} has no work type “${workTypeRef}”. Its work types: ` +
            `${spaceTypes.map((type) => type.name).join(', ')}. Add one with ` +
            'jira_admin_propose_work_type first.'
        );
      }
      if (workType.subtask) {
        return errText(
          `“${workType.name}” is a subtask type; a request type needs a standard one.`
        );
      }

      // The desk, on the JSM grant: its id, and that the name is free.
      const desk = await jiraAdminGet(
        context,
        jsm,
        `/rest/servicedeskapi/servicedesk/${encodeURIComponent(key)}`
      );
      if (!desk.ok) return errText(`The service desk for ${key}: ${desk.error}`);
      const deskRecord = rec(desk.body);
      const serviceDesk = {
        id: str(deskRecord.id),
        projectId: str(deskRecord.projectId) || str(spaceRecord.id),
        projectKey: str(deskRecord.projectKey) || key,
        projectName: str(deskRecord.projectName) || str(spaceRecord.name),
      };
      if (!serviceDesk.id) return errText(`Jira did not say the service desk id for ${key}.`);
      const held = await readRequestTypes(context, jsm, serviceDesk.id, name);
      if (!held.ok) return errText(`${key}’s request types: ${held.error}`);
      const taken = held.requestTypes.find(
        (type) => type.name.trim().toLowerCase() === name.toLowerCase()
      );
      if (taken) {
        const backing = spaceTypes.find((type) => type.id === taken.issueTypeId);
        return errText(
          `${key} has a request type “${taken.name}” already (${taken.id}` +
            (backing ? `, backed by “${backing.name}”` : '') +
            '). Choose another name, or change that one in Project settings.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const db = dbResult.val;
      const payload: RequestTypePayload = {
        serviceDesk,
        operations: [
          {
            op: 'create_request_type',
            name,
            description: text(args.description) || null,
            helpText: text(args.helpText) || null,
            workType: { id: workType.id, name: workType.name },
          },
        ],
      };
      const reason = text(args.reason);
      const change = await createChangeRequest(db, {
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: REQUEST_TYPE_KIND,
        title: requestTypeTitle(payload),
        reason: reason || undefined,
        payload,
      });

      const replaces = text(args.replaces);
      if (replaces) {
        const cancelled = await cancelChangeRequest(db, context.subject, replaces);
        notes.push(
          cancelled
            ? `Cancelled the request it replaces (${replaces}).`
            : `Did not cancel ${replaces}: it is not a pending request of this user’s.`
        );
      }

      const link = `${reviewPrefix(context)}${change.id}`;
      const { operations: described, reach } = describeChange(change);
      const lines = [
        'Proposed — nothing has changed in Jira yet.',
        '',
        ...operationLines(described),
        ...(reach ? ['', `Where: ${reach}`] : []),
        ...(notes.length > 0 ? ['', ...notes] : []),
        '',
        `Review and apply: ${link}`,
        `Change request ${change.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours. Only the ` +
          'user can apply it, from that page while signed in to Renkei — share the link.',
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        _meta: actMeta({ url: link }),
      };
    }
  );
}
