/**
 * jira_admin_propose_work_type — a work type for a space, proposed as a
 * change request the person applies from Renkei's review page
 * (lib/jira-admin/work-type.ts). Nothing changes in Jira here. And
 * jira_admin_list_work_type_icons, the system icons a proposal can pick.
 *
 * It reuses before it creates: a site-wide work type named as asked is
 * added to the space rather than a second one made. Set up `like` a work
 * type the space already has, the new one gets that one's screens and
 * workflow; otherwise the space's scheme defaults apply, and the result
 * says so.
 *
 * And it names reach before anyone applies: a work type scheme shared by
 * other spaces puts the work type in all of them, so those spaces are
 * named and the proposal refused unless the request says
 * `sharedScheme: true`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import {
  errText,
  jiraAdminGet,
  jiraAdminPages,
  rec,
  records,
  str,
  textResult,
  type JiraAdminAccess,
} from './client';
import { reviewPrefix } from './review-link';
import {
  CHANGE_REQUEST_TTL_HOURS,
  cancelChangeRequest,
  createChangeRequest,
} from '@/lib/jira-admin/change-requests';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import {
  WORK_TYPE_KIND,
  findWorkTypeIcon,
  readWorkTypeIcons,
  readWorkflowScheme,
  siteWideWorkTypes,
  workTypeTitle,
  type WorkTypeOperation,
  type WorkTypePayload,
} from '@/lib/jira-admin/work-type';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The most spaces looked through for the ones sharing a scheme. */
const MAX_PROJECT_PAGES = 5;
const PROJECTS_PER_LOOKUP = 50;

/**
 * The OTHER spaces on a work type scheme. Jira lists a scheme's spaces
 * only by asking per space, so this lists the site's spaces and asks in
 * batches; `more` when there were too many to look through, which a
 * caller treats as possibly shared. Null when Jira would not say.
 */
export async function otherSpacesOnWorkTypeScheme(
  scope: { subject?: string },
  access: JiraAdminAccess,
  schemeId: string,
  spaceId: string
): Promise<{ spaces: string[]; more: boolean } | null> {
  const projects = await jiraAdminPages(
    scope,
    access,
    '/rest/api/3/project/search',
    MAX_PROJECT_PAGES
  );
  if (!projects.ok) return null;
  const others = projects.values.filter((project) => str(project.id) !== spaceId);
  const keys = new Map(others.map((project) => [str(project.id), str(project.key)]));
  const spaces: string[] = [];
  for (let index = 0; index < others.length; index += PROJECTS_PER_LOOKUP) {
    const batch = others.slice(index, index + PROJECTS_PER_LOOKUP);
    const listing = await jiraAdminPages(
      scope,
      access,
      `/rest/api/3/issuetypescheme/project?${batch
        .map((project) => `projectId=${encodeURIComponent(str(project.id))}`)
        .join('&')}`
    );
    if (!listing.ok) return null;
    for (const item of listing.values) {
      if (str(rec(item.issueTypeScheme).id) !== schemeId) continue;
      for (const id of Array.isArray(item.projectIds) ? item.projectIds.map(str) : []) {
        const key = keys.get(id);
        if (key) spaces.push(key);
      }
    }
  }
  return { spaces: [...new Set(spaces)].sort(), more: projects.truncated };
}

export async function registerProposeWorkTypeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_list_work_type_icons',
    {
      title: 'Jira Admin · Read — List work type icons',
      description:
        'The icons a work type can have, from Jira’s system set: each one’s name (what ' +
        'jira_admin_propose_work_type takes as icon), id and image URL.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const icons = await readWorkTypeIcons(context, access);
      if (!icons.ok) return errText(`Reading the icons: ${icons.error}`);
      if (icons.icons.length === 0) return textResult('Jira listed no work type icons.');
      return textResult(
        [
          `${icons.icons.length} work type icons (name — id — image):`,
          ...icons.icons.map(
            (icon) => `${icon.name} — ${icon.id}${icon.url ? ` — ${icon.url}` : ''}`
          ),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'jira_admin_propose_work_type',
    {
      title: 'Jira Admin · Act — Propose a work type for a space',
      description:
        'Propose a work type (issue type) for a company-managed space: a new one by name — a ' +
        'work type already named that is added to the space instead of created twice — with ' +
        'an optional description, icon (a name from jira_admin_list_work_type_icons, e.g. ' +
        '“bug”) and subtask: true for a subtask type. It is added to the space’s work type ' +
        'scheme; a scheme other spaces share is named, and only used with sharedScheme: true ' +
        '(the work type appears in those spaces as well). Pass like with a work type the ' +
        'space already has to give the new one that type’s screens and workflow, or workflow ' +
        'with a workflow’s name; otherwise the space’s scheme defaults apply. For a service ' +
        'project, customers see a work type on the portal only through a request type — ' +
        'propose one with jira_admin_propose_request_type once this is applied. Nothing ' +
        'changes in Jira: this saves a change request, and the user applies it from the ' +
        `Renkei review page linked in the result (it expires in ${CHANGE_REQUEST_TTL_HOURS} ` +
        'hours). Give the user that link.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        space: z.string().min(1).describe('The space (project) key, e.g. OPS'),
        name: z.string().min(1).max(60).describe('The work type’s name, e.g. Incident'),
        description: z.string().max(1000).describe('A new work type’s description').optional(),
        subtask: z.boolean().describe('A subtask type (default: a standard one)').optional(),
        icon: z
          .string()
          .max(100)
          .describe(
            'An icon by name (e.g. bug, story, task) or id — see jira_admin_list_work_type_icons'
          )
          .optional(),
        like: z
          .string()
          .max(60)
          .describe('A work type the space has already, whose screens and workflow this one gets')
          .optional(),
        workflow: z
          .string()
          .max(255)
          .describe('The workflow to run it on, by exact name (overrides like’s workflow)')
          .optional(),
        sharedScheme: z
          .boolean()
          .describe(
            'Also go ahead when the space’s work type scheme is shared — the work type ' +
              'appears in those spaces too (default false)'
          )
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

      const spaceRef = text(args.space).toUpperCase();
      const name = text(args.name);
      const subtask = args.subtask === true;
      const iconRef = text(args.icon);
      const likeRef = text(args.like);
      const workflowRef = text(args.workflow);
      if (!spaceRef) return errText('space is required');
      if (!name) return errText('name is required');
      const notes: string[] = [];

      // The space: company-managed, with its work types.
      const project = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceRef)}`
      );
      if (!project.ok) return errText(`Space ${spaceRef}: ${project.error}`);
      const spaceRecord = rec(project.body);
      const space = {
        id: str(spaceRecord.id),
        key: str(spaceRecord.key) || spaceRef,
        serviceDesk: str(spaceRecord.projectTypeKey) === 'service_desk',
      };
      if (spaceRecord.simplified === true || spaceRecord.style === 'next-gen') {
        return errText(
          `${space.key} is team-managed: its work types live inside the space and are set up ` +
            'there, not with site work types.'
        );
      }
      const spaceTypes = records(spaceRecord.issueTypes).map((type) => ({
        id: str(type.id),
        name: str(type.name),
      }));

      // The work type: one of that name site-wide, or a new one.
      const listing = await jiraAdminGet(context, access, '/rest/api/3/issuetype');
      if (!listing.ok) return errText(`Reading the site’s work types: ${listing.error}`);
      const existing = siteWideWorkTypes(listing.body).find(
        (type) => str(type.name).trim().toLowerCase() === name.toLowerCase()
      );
      const workType = {
        id: existing ? str(existing.id) : null,
        name: existing ? str(existing.name) : name,
        subtask: existing ? existing.subtask === true : subtask,
      };
      const inSpace = workType.id !== null && spaceTypes.some((type) => type.id === workType.id);
      if (existing) {
        notes.push(
          `A work type named “${workType.name}” exists already (${workType.id}), so it is ` +
            (inSpace
              ? `used — ${space.key} has it already.`
              : 'used rather than a second one created.')
        );
        if (subtask !== workType.subtask) {
          notes.push(
            `It is a ${workType.subtask ? 'subtask' : 'standard'} type, which stays as it is.`
          );
        }
      }

      const operations: WorkTypeOperation[] = [];
      if (!workType.id) {
        operations.push({
          op: 'create_work_type',
          name,
          description: text(args.description) || null,
          subtask,
        });
      }

      // Its icon, from the system set.
      if (iconRef) {
        const icons = await readWorkTypeIcons(context, access);
        if (!icons.ok) return errText(`Reading the icons: ${icons.error}`);
        const icon = findWorkTypeIcon(icons.icons, iconRef);
        if (!icon) {
          return errText(
            `No work type icon is called “${iconRef}”. The icons: ` +
              `${icons.icons.map((candidate) => candidate.name).join(', ')} ` +
              '(jira_admin_list_work_type_icons shows each one’s image).'
          );
        }
        if (existing && str(existing.avatarId) === icon.id) {
          notes.push(`It has the “${icon.name}” icon already.`);
        } else {
          operations.push({ op: 'set_icon', avatarId: icon.id, iconName: icon.name });
        }
      }

      // Its scheme: the space's, and who else runs on it.
      const association = await jiraAdminGet(
        context,
        access,
        `/rest/api/3/issuetypescheme/project?projectId=${encodeURIComponent(space.id)}`
      );
      if (!association.ok) return errText(`${space.key}’s work type scheme: ${association.error}`);
      const scheme = rec(records(association.body)[0]?.issueTypeScheme);
      if (!str(scheme.id))
        return errText(`Jira did not say which work type scheme ${space.key} uses.`);
      if (!inSpace) {
        const sharing = await otherSpacesOnWorkTypeScheme(
          context,
          access,
          str(scheme.id),
          space.id
        );
        if (sharing === null && args.sharedScheme !== true) {
          return errText(
            `Jira would not say which other spaces run on ${space.key}’s work type scheme, so ` +
              'Renkei cannot tell whether the work type would appear elsewhere too. Pass ' +
              'sharedScheme: true to go ahead anyway.'
          );
        }
        if (sharing && (sharing.spaces.length > 0 || sharing.more) && args.sharedScheme !== true) {
          const names = sharing.spaces.slice(0, 8).join(', ');
          return errText(
            `${space.key}’s work type scheme “${str(scheme.name)}” is shared` +
              (names
                ? ` with ${names}${sharing.more || sharing.spaces.length > 8 ? ' and more' : ''}`
                : ' with other spaces (too many to check)') +
              ', and the work type would appear there as well. Pass sharedScheme: true to go ' +
              `ahead, or give ${space.key} a work type scheme of its own first.`
          );
        }
        operations.push({
          op: 'add_to_scheme',
          schemeId: str(scheme.id),
          schemeName: str(scheme.name),
          sharedWith: sharing?.spaces ?? [],
          moreShared: sharing ? sharing.more : true,
        });
      }

      // Its screens and workflow, like another of the space's work types.
      const like = likeRef
        ? spaceTypes.find((type) => type.name.toLowerCase() === likeRef.toLowerCase())
        : undefined;
      if (likeRef && !like) {
        return errText(
          `${space.key} has no work type “${likeRef}” to set this one up like. Its work ` +
            `types: ${spaceTypes.map((type) => type.name).join(', ')}.`
        );
      }
      if (like) {
        const screens = await jiraAdminGet(
          context,
          access,
          `/rest/api/3/issuetypescreenscheme/project?projectId=${encodeURIComponent(space.id)}`
        );
        if (!screens.ok) return errText(`${space.key}’s screens scheme: ${screens.error}`);
        const screensScheme = rec(records(screens.body)[0]?.issueTypeScreenScheme);
        if (!str(screensScheme.id)) {
          return errText(`Jira did not say which screens scheme ${space.key} uses.`);
        }
        const mapping = await jiraAdminPages(
          context,
          access,
          `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${encodeURIComponent(str(screensScheme.id))}`
        );
        if (!mapping.ok) return errText(`${space.key}’s screens scheme: ${mapping.error}`);
        const likeScreens = str(
          mapping.values.find((item) => str(item.issueTypeId) === like.id)?.screenSchemeId
        );
        const ownScreens = str(
          mapping.values.find((item) => str(item.issueTypeId) === workType.id)?.screenSchemeId
        );
        if (!likeScreens) {
          notes.push(
            `“${like.name}” uses ${space.key}’s default screens, so “${workType.name}” will too.`
          );
        } else if (ownScreens === likeScreens) {
          notes.push(`“${workType.name}” is on “${like.name}”’s screens in ${space.key} already.`);
        } else if (ownScreens) {
          notes.push(
            `“${workType.name}” has screens of its own in ${space.key} already, which stay as ` +
              'they are.'
          );
        } else {
          const named = await jiraAdminGet(
            context,
            access,
            `/rest/api/3/screenscheme?id=${encodeURIComponent(likeScreens)}`
          );
          const screenSchemeName = named.ok ? str(records(named.body)[0]?.name) : '';
          operations.push({
            op: 'map_screens',
            schemeId: str(screensScheme.id),
            schemeName: str(screensScheme.name),
            screenSchemeId: likeScreens,
            screenSchemeName: screenSchemeName || `screen scheme ${likeScreens}`,
            likeName: like.name,
          });
        }
      }
      if (like || workflowRef) {
        const association = await jiraAdminGet(
          context,
          access,
          `/rest/api/3/workflowscheme/project?projectId=${encodeURIComponent(space.id)}`
        );
        if (!association.ok) return errText(`${space.key}’s workflow scheme: ${association.error}`);
        const workflowScheme = rec(records(association.body)[0]?.workflowScheme);
        if (!str(workflowScheme.id)) {
          return errText(`Jira did not say which workflow scheme ${space.key} uses.`);
        }
        const read = await readWorkflowScheme(context, access, str(workflowScheme.id));
        if (!read.ok) return errText(`${space.key}’s workflow scheme: ${read.error}`);
        const { scheme: workflows } = read;
        let wanted: { id: string; name: string } | null = null;
        let likeName: string | null = null;
        if (workflowRef) {
          const search = await jiraAdminGet(
            context,
            access,
            `/rest/api/3/workflows/search?queryString=${encodeURIComponent(workflowRef)}&maxResults=50`
          );
          if (!search.ok)
            return errText(`Looking for the workflow “${workflowRef}”: ${search.error}`);
          const found = records(search.body).find(
            (workflow) => str(workflow.name).trim().toLowerCase() === workflowRef.toLowerCase()
          );
          if (!found) {
            const close = records(search.body)
              .slice(0, 5)
              .map((workflow) => str(workflow.name));
            return errText(
              `No workflow is named “${workflowRef}”.` +
                (close.length > 0 ? ` Closest: ${close.join(', ')}.` : '')
            );
          }
          wanted = { id: str(found.id), name: str(found.name) };
        } else if (like) {
          const likeWorkflow = workflows.workflows.find((workflow) =>
            workflow.issueTypeIds.includes(like.id)
          );
          wanted = likeWorkflow
            ? { id: likeWorkflow.id, name: likeWorkflow.name }
            : { id: workflows.defaultWorkflow.id, name: workflows.defaultWorkflow.name };
          likeName = like.name;
        }
        const own = workflows.workflows.find((workflow) =>
          workType.id ? workflow.issueTypeIds.includes(workType.id) : false
        );
        if (wanted && own) {
          notes.push(
            own.id === wanted.id
              ? `“${workType.name}” runs on “${own.name}” in ${space.key} already.`
              : `“${workType.name}” runs on “${own.name}” in ${space.key} already, which stays ` +
                  'as it is — change it in Jira.'
          );
        } else if (wanted && wanted.id === workflows.defaultWorkflow.id) {
          notes.push(
            `“${wanted.name}” is ${space.key}’s default workflow, which “${workType.name}” ` +
              'runs on without a mapping.'
          );
        } else if (wanted) {
          operations.push({
            op: 'map_workflow',
            schemeId: workflows.id,
            schemeName: workflows.name,
            workflowId: wanted.id,
            workflowName: wanted.name,
            likeName,
          });
        }
      }

      if (operations.length === 0) {
        return errText(
          `Nothing to do: ${space.key} has the work type “${workType.name}” already` +
            (iconRef ? ', with that icon' : '') +
            '.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
      const db = dbResult.val;
      const payload: WorkTypePayload = { space, workType, operations };
      const reason = text(args.reason);
      const change = await createChangeRequest(db, {
        subject: context.subject,
        agentId: context.agent?.agentId,
        cloudId: access.cloudId,
        siteUrl: access.siteUrl,
        kind: WORK_TYPE_KIND,
        title: workTypeTitle(payload),
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
      if (space.serviceDesk) {
        notes.push(
          `${space.key} is a service project: customers see a work type on the portal only ` +
            'through a request type. Once this is applied, propose one with ' +
            'jira_admin_propose_request_type.'
        );
      }
      if (!like && !workflowRef) {
        notes.push(
          `No like or workflow was given, so “${workType.name}” gets ${space.key}’s default ` +
            'screens and workflow.'
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
