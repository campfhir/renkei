/**
 * Automation rules: two reads and three proposals, every one on the
 * person's Atlassian API token (./automation-client.ts) — the Automation
 * API refuses OAuth apps — and offered only once a token is saved
 * (index.ts). The proposals store change requests the person applies from
 * Renkei's review page (lib/jira-admin/automation.ts); nothing here writes.
 *
 * Spaces and issues are named by key and resolved to ids on the Jira
 * Administration grant (the ARIs a rule is scoped to and run on carry
 * ids); rules are named by uuid or exact name, and a name that matches
 * several rules is refused, not guessed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { JiraAdminAuth } from './jira-admin-auth';
import { errText, jiraAdminGet, jiraAdminPages, rec, str, textResult } from './client';
import type { JiraAdminAccess } from './client';
import { projectAri, resolveAutomationAccess, type AutomationAccess } from './automation-client';
import { reviewPrefix } from './review-link';
import { CHANGE_REQUEST_TTL_HOURS, createChangeRequest } from '@/lib/jira-admin/change-requests';
import { replaceRequest } from './changes';
import { describeChange, operationLines } from '@/lib/jira-admin/describe';
import {
  AUTOMATION_RULE_KIND,
  AUTOMATION_RUN_KIND,
  AUTOMATION_STATE_KIND,
  automationRuleTitle,
  automationRunTitle,
  automationStateTitle,
  definitionForCopy,
  isRuleState,
  readRule,
  readRuleSummaries,
  scopeArisFor,
  summarizeRule,
  type AutomationRulePayload,
  type AutomationRunPayload,
  type AutomationStatePayload,
  type RuleSummary,
} from '@/lib/jira-admin/automation';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const MAX_RULES = 20;
const MAX_ISSUES = 50;
const MAX_PROJECT_PAGES = 5;

type Resolved = { admin: JiraAdminAccess; automation: AutomationAccess };

/** Both grants, or the sentence that says which is missing. */
async function resolveBoth(
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<Resolved | string> {
  const admin = await auth.resolve();
  if (typeof admin === 'string') return admin;
  const automation = await resolveAutomationAccess(context);
  if (typeof automation === 'string') return automation;
  if (automation.cloudId !== admin.cloudId) {
    return (
      'Your Atlassian API token was saved for a different Jira site than your Jira Administration ' +
      'connection is on now. Save it again on the Connectors page.'
    );
  }
  return { admin, automation };
}

/** Space keys by id, for naming the scopes rules carry; empty when Jira would not say. */
async function projectKeys(
  context: MCPToolContext,
  admin: JiraAdminAccess
): Promise<Map<string, string>> {
  const projects = await jiraAdminPages(
    context,
    admin,
    '/rest/api/3/project/search',
    MAX_PROJECT_PAGES
  );
  if (!projects.ok) return new Map();
  return new Map(projects.values.map((project) => [str(project.id), str(project.key)]));
}

/** A space by key, as `{ id, key }`. */
async function findProject(
  context: MCPToolContext,
  admin: JiraAdminAccess,
  key: string
): Promise<{ ok: true; project: { id: string; key: string } } | { ok: false; reason: string }> {
  const result = await jiraAdminGet(
    context,
    admin,
    `/rest/api/3/project/${encodeURIComponent(key)}`
  );
  if (!result.ok) return { ok: false, reason: `Space ${key}: ${result.error}` };
  const record = rec(result.body);
  return { ok: true, project: { id: str(record.id), key: str(record.key) || key } };
}

function scopeWords(summary: RuleSummary, keys: Map<string, string>): string {
  if (summary.projectIds.length === 0) {
    return summary.ruleScopeARIs.length === 0 ? 'site-wide' : 'site-wide (or another product)';
  }
  return summary.projectIds.map((id) => keys.get(id) ?? `space ${id}`).join(', ');
}

/** A rule by uuid or exact name, from the summaries; several of the name is refused. */
function pickRule(
  rules: RuleSummary[],
  reference: string
): { ok: true; rule: RuleSummary } | { ok: false; reason: string } {
  const wanted = reference.trim();
  const byId = rules.find((rule) => rule.uuid === wanted);
  if (byId) return { ok: true, rule: byId };
  const named = rules.filter((rule) => rule.name.trim().toLowerCase() === wanted.toLowerCase());
  if (named.length === 1 && named[0]) return { ok: true, rule: named[0] };
  if (named.length > 1) {
    return {
      ok: false,
      reason:
        `${named.length} automation rules are named “${wanted}” — pass the uuid of the one you ` +
        `mean: ${named.map((rule) => rule.uuid).join(', ')}`,
    };
  }
  const close = rules
    .filter((rule) => rule.name.toLowerCase().includes(wanted.toLowerCase()))
    .slice(0, 5)
    .map((rule) => `${rule.name} (${rule.uuid})`);
  return {
    ok: false,
    reason:
      `No automation rule is named “${wanted}”.` +
      (close.length > 0 ? ` Closest: ${close.join(', ')}.` : ''),
  };
}

function ruleLine(rule: RuleSummary, keys: Map<string, string>): string {
  const updated = rule.updated ? new Date(rule.updated).toISOString().slice(0, 10) : '';
  return (
    `${rule.name} — ${rule.uuid} — ${rule.state.toLowerCase() || 'unknown'} — ${scopeWords(rule, keys)}` +
    (rule.labels.length > 0 ? ` — labels: ${rule.labels.join(', ')}` : '') +
    (updated ? ` — updated ${updated}` : '')
  );
}

async function saveAndAnswer(
  context: MCPToolContext,
  access: JiraAdminAccess,
  input: { kind: string; title: string; payload: unknown; reason: string; replaces: string },
  notes: string[]
) {
  if (!context.subject) return errText('No signed-in subject on this MCP session.');
  const dbResult = getDatabase();
  if (!dbResult.ok) return errText('Database unavailable; nothing was proposed.');
  const db = dbResult.val;
  const change = await createChangeRequest(db, {
    subject: context.subject,
    agentId: context.agent?.agentId,
    cloudId: access.cloudId,
    siteUrl: access.siteUrl,
    kind: input.kind,
    title: input.title,
    reason: input.reason || undefined,
    payload: input.payload,
  });
  if (input.replaces) {
    notes.push(await replaceRequest(db, context.subject, input.replaces, change.id));
  }
  const link = `${reviewPrefix(context)}${change.id}`;
  const { operations, reach } = describeChange(change);
  const lines = [
    'Proposed — nothing has changed in Jira yet.',
    '',
    ...operationLines(operations),
    ...(reach ? ['', `Where: ${reach}`] : []),
    ...(notes.length > 0 ? ['', ...notes] : []),
    '',
    `Review and apply: ${link}`,
    `Change request ${change.id}; it expires in ${CHANGE_REQUEST_TTL_HOURS} hours. Only the ` +
      'operator can approve it, from that page while signed in to Renkei, and it then applies in the background — share the link. Operators have been told it is waiting.',
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    _meta: actMeta({ url: link }),
  };
}

const reasonAndReplaces = {
  reason: z.string().max(1000).describe('Why — shown to the user on the review page').optional(),
  replaces: z
    .string()
    .describe(
      'The id of a pending change request of this user’s that this one supersedes; it is ' +
        'cancelled once this one is saved'
    )
    .optional(),
};

export async function registerAutomationTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  server.registerTool(
    'jira_admin_list_automation_rules',
    {
      title: 'Jira Admin · Read — List automation rules',
      description:
        'The site’s automation rules, on the user’s Atlassian API token: each one’s name, uuid, ' +
        'whether it is enabled, the spaces it is scoped to (or site-wide), labels and when it ' +
        'last changed. Filter by space (key), state or trigger type. jira_admin_get_automation_rule ' +
        'shows one rule’s definition.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        space: z.string().min(1).describe('Only rules scoped to this space (key)').optional(),
        state: z.enum(['enabled', 'disabled']).describe('Only rules in this state').optional(),
        trigger: z
          .string()
          .max(100)
          .describe('Only rules with this trigger type, e.g. jira.issue.event.trigger:created')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const resolved = await resolveBoth(context, auth);
      if (typeof resolved === 'string') return errText(resolved);
      const { admin, automation } = resolved;
      const spaceRef = text(args.space).toUpperCase();
      let scopeAri: string | undefined;
      if (spaceRef) {
        const found = await findProject(context, admin, spaceRef);
        if (!found.ok) return errText(found.reason);
        scopeAri = projectAri(automation.cloudId, found.project.id);
      }
      const stateRef = text(args.state).toUpperCase();
      const read = await readRuleSummaries(context, automation, {
        ...(scopeAri ? { scopeAri } : {}),
        ...(isRuleState(stateRef) ? { state: stateRef } : {}),
        ...(text(args.trigger) ? { trigger: text(args.trigger) } : {}),
      });
      if (!read.ok) return errText(`Reading the automation rules: ${read.error}`);
      if (read.rules.length === 0) return textResult('No automation rules match.');
      const keys = await projectKeys(context, admin);
      const lines = [
        `${read.rules.length} automation rule${read.rules.length === 1 ? '' : 's'}${read.truncated ? ' (and more)' : ''}, as ${automation.email}:`,
        ...read.rules.map((rule) => ruleLine(rule, keys)),
      ];
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Uuid, State, Spaces, Labels, Updated) scans faster than this list'
        )
      );
    }
  );

  server.registerTool(
    'jira_admin_get_automation_rule',
    {
      title: 'Jira Admin · Read — An automation rule',
      description:
        'One automation rule in full, by uuid or exact name: its state, scope, trigger and ' +
        'steps in words, and the definition JSON the Automation API holds (trigger and ' +
        'components) — the shape jira_admin_propose_automation_rule takes to create or change ' +
        'a rule.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        rule: z.string().min(1).describe('The rule’s uuid or exact name'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const resolved = await resolveBoth(context, auth);
      if (typeof resolved === 'string') return errText(resolved);
      const { admin, automation } = resolved;
      const ruleRef = text(args.rule);
      if (!ruleRef) return errText('rule is required');
      const summaries = await readRuleSummaries(context, automation);
      if (!summaries.ok) return errText(`Reading the automation rules: ${summaries.error}`);
      const picked = pickRule(summaries.rules, ruleRef);
      if (!picked.ok) return errText(picked.reason);
      const read = await readRule(context, automation, picked.rule.uuid);
      if (!read.ok) return errText(`Reading the rule: ${read.error}`);
      if (!read.read) return errText(`The rule ${picked.rule.uuid} no longer exists.`);
      const keys = await projectKeys(context, admin);
      const { summary, rule } = read.read;
      const lines = [
        ruleLine(summary, keys),
        ...summarizeRule(rule),
        `Author: ${summary.authorAccountId || 'unknown'}` +
          (str(rec(rule.actor).actor) ? `; runs as ${str(rec(rule.actor).actor)}` : ''),
        '',
        'Definition:',
        JSON.stringify(
          {
            name: rule.name,
            description: rule.description,
            state: rule.state,
            ruleScopeARIs: rule.ruleScopeARIs,
            labels: rule.labels,
            canOtherRuleTrigger: rule.canOtherRuleTrigger,
            notifyOnError: rule.notifyOnError,
            trigger: rule.trigger,
            components: rule.components,
          },
          null,
          2
        ),
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'jira_admin_propose_automation_rule_state',
    {
      title: 'Jira Admin · Act — Propose enabling or disabling automation rules',
      description:
        'Propose switching automation rules on or off, by uuid or exact name. Applying runs on ' +
        'the user’s Atlassian API token. Nothing changes in Jira: this saves a change request, ' +
        'and the user applies it from the Renkei review page linked in the result (it expires ' +
        `in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        rules: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_RULES)
          .describe('Rules, by uuid or exact name'),
        enabled: z.boolean().describe('true to enable them, false to disable'),
        ...reasonAndReplaces,
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const resolved = await resolveBoth(context, auth);
      if (typeof resolved === 'string') return errText(resolved);
      const { automation } = resolved;
      const refs = (Array.isArray(args.rules) ? args.rules.map(text) : []).filter(Boolean);
      if (refs.length === 0) return errText('rules is required');
      const to = args.enabled === true ? 'ENABLED' : 'DISABLED';
      const summaries = await readRuleSummaries(context, automation);
      if (!summaries.ok) return errText(`Reading the automation rules: ${summaries.error}`);
      const notes: string[] = [];
      const payload: AutomationStatePayload = { rules: [] };
      for (const ref of refs) {
        const picked = pickRule(summaries.rules, ref);
        if (!picked.ok) return errText(picked.reason);
        if (picked.rule.state === to) {
          notes.push(`“${picked.rule.name}” is ${to.toLowerCase()} already.`);
          continue;
        }
        if (payload.rules.some((rule) => rule.uuid === picked.rule.uuid)) continue;
        payload.rules.push({
          uuid: picked.rule.uuid,
          name: picked.rule.name,
          from: isRuleState(picked.rule.state)
            ? picked.rule.state
            : to === 'ENABLED'
              ? 'DISABLED'
              : 'ENABLED',
          to,
        });
      }
      if (payload.rules.length === 0) {
        return errText(`Nothing to do: ${notes.join(' ')}`);
      }
      return saveAndAnswer(
        context,
        automation,
        {
          kind: AUTOMATION_STATE_KIND,
          title: automationStateTitle(payload),
          payload,
          reason: text(args.reason),
          replaces: text(args.replaces),
        },
        notes
      );
    }
  );

  server.registerTool(
    'jira_admin_propose_automation_rule',
    {
      title: 'Jira Admin · Act — Propose a new or changed automation rule',
      description:
        'Propose an automation rule. To create one: name, the spaces it is scoped to (keys; none ' +
        'for site-wide) and a definition — either definition (an object with trigger and ' +
        'components in the shape jira_admin_get_automation_rule shows) or copyFrom (an existing ' +
        'rule’s uuid or name, whose trigger and steps are copied). To change one: update (its ' +
        'uuid or name) with any of name, description, labels, spaces, enabled or a new ' +
        'definition; what is not given stays as it is. Jira validates the definition when the ' +
        'change is applied, on the user’s Atlassian API token. Nothing changes in Jira: this ' +
        'saves a change request, and the user applies it from the Renkei review page linked in ' +
        `the result (it expires in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        update: z.string().describe('An existing rule to change, by uuid or exact name').optional(),
        name: z.string().max(255).describe('The rule’s name (required for a new rule)').optional(),
        description: z.string().max(2000).describe('The rule’s description').optional(),
        labels: z
          .array(z.string().min(1).max(100))
          .max(20)
          .describe('The rule’s labels')
          .optional(),
        spaces: z
          .array(z.string().min(1))
          .max(50)
          .describe('The spaces the rule is scoped to, by key; an empty list means site-wide')
          .optional(),
        enabled: z
          .boolean()
          .describe('Whether the rule is enabled (new rules: default true)')
          .optional(),
        definition: z
          .record(z.string(), z.unknown())
          .describe(
            'The rule’s trigger and components, as jira_admin_get_automation_rule shows them'
          )
          .optional(),
        copyFrom: z
          .string()
          .describe('A new rule’s definition copied from this existing rule (uuid or exact name)')
          .optional(),
        ...reasonAndReplaces,
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const resolved = await resolveBoth(context, auth);
      if (typeof resolved === 'string') return errText(resolved);
      const { admin, automation } = resolved;
      const updateRef = text(args.update);
      const copyRef = text(args.copyFrom);
      const definition = rec(args.definition);
      const hasDefinition = Object.keys(definition).length > 0;
      const notes: string[] = [];

      // The spaces, by key, when given.
      let projects: { id: string; key: string }[] | null = null;
      if (Array.isArray(args.spaces)) {
        projects = [];
        for (const key of [...new Set(args.spaces.map(text).filter(Boolean))]) {
          const found = await findProject(context, admin, key.toUpperCase());
          if (!found.ok) return errText(found.reason);
          projects.push(found.project);
        }
      }

      const summaries =
        updateRef || copyRef
          ? await readRuleSummaries(context, automation)
          : { ok: true as const, rules: [], truncated: false };
      if (!summaries.ok) return errText(`Reading the automation rules: ${summaries.error}`);

      if (!updateRef) {
        // A new rule.
        const name = text(args.name);
        if (!name) return errText('A new rule needs a name.');
        if (hasDefinition === Boolean(copyRef)) {
          return errText('Pass exactly one of definition or copyFrom for a new rule.');
        }
        let base: Record<string, unknown> = definition;
        if (copyRef) {
          const picked = pickRule(summaries.rules, copyRef);
          if (!picked.ok) return errText(picked.reason);
          const read = await readRule(context, automation, picked.rule.uuid);
          if (!read.ok) return errText(`Reading “${picked.rule.name}”: ${read.error}`);
          if (!read.read) return errText(`The rule ${picked.rule.uuid} no longer exists.`);
          base = definitionForCopy(read.read.rule);
          notes.push(`Trigger and steps copied from “${picked.rule.name}” (${picked.rule.uuid}).`);
        }
        if (Object.keys(rec(base.trigger)).length === 0) {
          return errText('The definition needs a trigger (an object with a type and value).');
        }
        if (!Array.isArray(base.components)) {
          return errText('The definition needs components (the rule’s steps, an array).');
        }
        const scoped = projects ?? [];
        const rule: Record<string, unknown> = {
          ...base,
          name,
          description: text(args.description) || str(base.description),
          state: args.enabled === false ? 'DISABLED' : 'ENABLED',
          ruleScopeARIs: scopeArisFor(automation.cloudId, scoped),
          labels: Array.isArray(args.labels)
            ? args.labels.map(text).filter(Boolean)
            : (base.labels ?? []),
          actor:
            Object.keys(rec(base.actor)).length > 0
              ? base.actor
              : { type: 'ACCOUNT_ID', actor: automation.accountId },
          authorAccountId: automation.accountId,
          canOtherRuleTrigger:
            typeof base.canOtherRuleTrigger === 'boolean' ? base.canOtherRuleTrigger : false,
          notifyOnError: str(base.notifyOnError) || 'FIRSTERROR',
        };
        const payload: AutomationRulePayload = {
          mode: 'create',
          uuid: null,
          name,
          projects: scoped,
          updatedAt: null,
          rule,
          changes: copyRef ? [notes[0] ?? ''] : [],
        };
        return saveAndAnswer(
          context,
          automation,
          {
            kind: AUTOMATION_RULE_KIND,
            title: automationRuleTitle(payload),
            payload,
            reason: text(args.reason),
            replaces: text(args.replaces),
          },
          notes
        );
      }

      // A changed rule: what is not given stays as it is.
      const picked = pickRule(summaries.rules, updateRef);
      if (!picked.ok) return errText(picked.reason);
      const read = await readRule(context, automation, picked.rule.uuid);
      if (!read.ok) return errText(`Reading “${picked.rule.name}”: ${read.error}`);
      if (!read.read) return errText(`The rule ${picked.rule.uuid} no longer exists.`);
      const current = read.read;
      const rule: Record<string, unknown> = { ...current.rule };
      const changes: string[] = [];
      const name = text(args.name);
      if (name && name !== str(current.rule.name)) {
        rule.name = name;
        changes.push(`Rename it from “${str(current.rule.name)}” to “${name}”`);
      }
      if (
        typeof args.description === 'string' &&
        text(args.description) !== str(current.rule.description)
      ) {
        rule.description = text(args.description);
        changes.push(
          text(args.description)
            ? `Set its description to “${text(args.description)}”`
            : 'Clear its description'
        );
      }
      if (Array.isArray(args.labels)) {
        const labels = args.labels.map(text).filter(Boolean);
        if (
          labels.join('\n') !==
          (Array.isArray(current.rule.labels) ? current.rule.labels.map(str) : []).join('\n')
        ) {
          rule.labels = labels;
          changes.push(
            labels.length > 0 ? `Set its labels to ${labels.join(', ')}` : 'Clear its labels'
          );
        }
      }
      const keys = await projectKeys(context, admin);
      let scoped = current.summary.projectIds.map((id) => ({
        id,
        key: keys.get(id) ?? `space ${id}`,
      }));
      if (projects !== null) {
        const aris = scopeArisFor(automation.cloudId, projects);
        if (aris.join('\n') !== current.summary.ruleScopeARIs.join('\n')) {
          rule.ruleScopeARIs = aris;
          scoped = projects;
          changes.push(
            projects.length > 0
              ? `Scope it to ${projects.map((project) => project.key).join(', ')}` +
                  (current.summary.projectIds.length > 0
                    ? ` (was ${current.summary.projectIds.map((id) => keys.get(id) ?? id).join(', ')})`
                    : ' (was site-wide)')
              : 'Make it site-wide'
          );
        }
      }
      if (typeof args.enabled === 'boolean') {
        const state = args.enabled ? 'ENABLED' : 'DISABLED';
        if (state !== str(current.rule.state)) {
          rule.state = state;
          changes.push(args.enabled ? 'Enable it' : 'Disable it');
        }
      }
      if (hasDefinition) {
        if (
          Object.keys(rec(definition.trigger)).length === 0 ||
          !Array.isArray(definition.components)
        ) {
          return errText('A new definition needs a trigger and components.');
        }
        rule.trigger = definition.trigger;
        rule.components = definition.components;
        changes.push(
          `Replace its trigger and steps (${summarizeRule(definition)[0] ?? 'new definition'})`
        );
      }
      if (changes.length === 0) {
        return errText(`Nothing to do: “${current.summary.name}” is as asked already.`);
      }
      const payload: AutomationRulePayload = {
        mode: 'update',
        uuid: current.summary.uuid,
        name: str(rule.name) || current.summary.name,
        projects: scoped,
        updatedAt: current.summary.updated,
        rule,
        changes,
      };
      return saveAndAnswer(
        context,
        automation,
        {
          kind: AUTOMATION_RULE_KIND,
          title: automationRuleTitle(payload),
          payload,
          reason: text(args.reason),
          replaces: text(args.replaces),
        },
        notes
      );
    }
  );

  server.registerTool(
    'jira_admin_propose_automation_run',
    {
      title: 'Jira Admin · Act — Propose running a manual automation rule',
      description:
        'Propose running a manually triggered automation rule (by uuid or exact name) on issues ' +
        '(by key), with any inputs the rule asks for. Applying invokes it once on each issue, ' +
        'on the user’s Atlassian API token. Nothing changes in Jira: this saves a change ' +
        'request, and the user applies it from the Renkei review page linked in the result (it ' +
        `expires in ${CHANGE_REQUEST_TTL_HOURS} hours). Give the user that link.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        rule: z.string().min(1).describe('The manual rule, by uuid or exact name'),
        issues: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_ISSUES)
          .describe('Issue keys to run it on'),
        inputs: z
          .record(z.string(), z.unknown())
          .describe('Values for the inputs the rule asks for, by name')
          .optional(),
        ...reasonAndReplaces,
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText('No signed-in subject on this MCP session.');
      const resolved = await resolveBoth(context, auth);
      if (typeof resolved === 'string') return errText(resolved);
      const { admin, automation } = resolved;
      const ruleRef = text(args.rule);
      const keys = [
        ...new Set(
          (Array.isArray(args.issues) ? args.issues.map(text) : [])
            .map((key) => key.toUpperCase())
            .filter(Boolean)
        ),
      ];
      if (!ruleRef) return errText('rule is required');
      if (keys.length === 0) return errText('issues is required');
      const summaries = await readRuleSummaries(context, automation);
      if (!summaries.ok) return errText(`Reading the automation rules: ${summaries.error}`);
      const picked = pickRule(summaries.rules, ruleRef);
      if (!picked.ok) return errText(picked.reason);
      if (picked.rule.state !== 'ENABLED') {
        return errText(
          `“${picked.rule.name}” is disabled, so it cannot run. Enable it first with ` +
            'jira_admin_propose_automation_rule_state.'
        );
      }
      const issues: { key: string; id: string }[] = [];
      for (const key of keys) {
        const result = await jiraAdminGet(
          context,
          admin,
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=id`
        );
        if (!result.ok) return errText(`Issue ${key}: ${result.error}`);
        const id = str(rec(result.body).id);
        if (!id) return errText(`Jira did not say the id of ${key}.`);
        issues.push({ key: str(rec(result.body).key) || key, id });
      }
      const inputs = rec(args.inputs);
      const payload: AutomationRunPayload = {
        rule: { uuid: picked.rule.uuid, name: picked.rule.name },
        issues,
        userInputs: Object.keys(inputs).length > 0 ? inputs : null,
      };
      return saveAndAnswer(
        context,
        automation,
        {
          kind: AUTOMATION_RUN_KIND,
          title: automationRunTitle(payload),
          payload,
          reason: text(args.reason),
          replaces: text(args.replaces),
        },
        []
      );
    }
  );
}
