import type { Scenario } from '../../domain';
import { toJson } from '../../memory/tables';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function rule(n: number, priority: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    category: 'marketing',
    match_type: 'domain',
    match_value: `d${n}.test`,
    priority,
    created_at: at(n),
    updated_at: at(n),
    ...extra,
  };
}

function template(n: number, senderKey: string, version: number, status: string) {
  return {
    id: id(100 + n),
    sender_key: senderKey,
    version,
    status,
    spec: [{ kind: 'literal', text: `t${n}` }],
    match_threshold: n % 2 ? 0.5 : 0.75,
    derived_by_upn: 'ann@x.test',
    created_at: at(n),
  };
}

function script(n: number, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(200 + n),
    name: `script ${n}`,
    script: `export default (t) => t // ${n}`,
    created_at: at(minute),
    updated_at: at(minute),
    ...extra,
  };
}

function model(n: number, enabled: boolean, settings: unknown) {
  return {
    id: id(300 + n),
    label: `model ${n}`,
    provider: 'openai',
    model: 'm',
    encrypted_secrets: 'sealed',
    enabled,
    settings: toJson(settings),
  };
}

const fixture = {
  email_classifier_rules: [
    rule(3, 10, { sender_key: 'acme', category: 'system_notification' }),
    rule(1, 20),
    rule(2, 10, { enabled: false, match_type: 'subject_contains' }),
  ],
  email_extraction_templates: [
    template(1, 'jira', 1, 'superseded'),
    template(2, 'jira', 2, 'active'),
    template(3, 'acme b', 1, 'active'),
    template(4, 'acme', 1, 'active'),
  ],
  email_cleaner_scripts: [
    script(2, 5, { applies_to: ['msg', 'evt'], compiled: 'compiled 2' }),
    script(1, 5, { enabled: false, last_error: 'boom' }),
    script(3, 1),
  ],
};

const newRule = {
  id: id(9),
  category: 'human',
  matchType: 'sender_email',
  matchValue: 'a@b.test',
  senderKey: null,
  priority: 5,
  enabled: true,
};

export const emailSanitizerScenarios: Scenario<DataStore>[] = [
  {
    method: 'emailSanitizer.listRules',
    name: 'by priority, ties by id',
    fixture,
    run: async (store) => store.emailSanitizer.listRules(),
  },
  {
    method: 'emailSanitizer.listRules',
    name: 'empty',
    run: async (store) => store.emailSanitizer.listRules(),
  },
  {
    method: 'emailSanitizer.upsertRule',
    name: 'inserts a new id, replaces an existing one',
    fixture,
    run: async (store) => {
      await store.emailSanitizer.upsertRule(newRule);
      await store.emailSanitizer.upsertRule({ ...newRule, id: id(1), priority: 1, enabled: false });
      return store.emailSanitizer.listRules();
    },
  },
  {
    method: 'emailSanitizer.insertRules',
    name: 'every rule given, none for an empty list',
    fixture,
    run: async (store) => {
      await store.emailSanitizer.insertRules([]);
      await store.emailSanitizer.insertRules([newRule, { ...newRule, id: id(10), priority: 50 }]);
      return { ids: (await store.emailSanitizer.listRules()).map((r) => r.id) };
    },
  },
  {
    method: 'emailSanitizer.deleteRule',
    name: 'counted',
    fixture,
    run: async (store) => [
      await store.emailSanitizer.deleteRule(id(1)),
      await store.emailSanitizer.deleteRule(id(1)),
      (await store.emailSanitizer.listRules()).map((r) => r.id),
    ],
  },
  {
    method: 'emailSanitizer.listActiveTemplates',
    name: 'active only, by sender key under collation',
    fixture,
    run: async (store) => store.emailSanitizer.listActiveTemplates(),
  },
  {
    method: 'emailSanitizer.saveTemplateVersion',
    name: 'supersedes the active version, numbers the next',
    fixture,
    run: async (store) => {
      const base = { spec: [{ kind: 'field', name: 'x' }], matchThreshold: 0.5, derivedByUpn: 'b' };
      const jira = await store.emailSanitizer.saveTemplateVersion({
        ...base,
        id: id(150),
        senderKey: 'jira',
      });
      const fresh = await store.emailSanitizer.saveTemplateVersion({
        ...base,
        id: id(151),
        senderKey: 'new',
      });
      return { jira, fresh, active: await store.emailSanitizer.listActiveTemplates() };
    },
  },
  {
    method: 'emailSanitizer.listScripts',
    name: 'creation order, ties by id',
    fixture,
    run: async (store) => store.emailSanitizer.listScripts(),
  },
  {
    method: 'emailSanitizer.insertScript',
    name: 'defaults filled',
    fixture,
    run: async (store) => {
      const fresh = {
        id: id(250),
        name: 'new',
        script: 'src',
        compiled: null,
        enabled: true,
        appliesTo: ['evt'],
      };
      await store.emailSanitizer.insertScript(fresh);
      const scripts = await store.emailSanitizer.listScripts();
      return { added: scripts.find((s) => s.id === id(250)) };
    },
  },
  {
    method: 'emailSanitizer.updateScript',
    name: 'replaces and clears the last error',
    fixture,
    run: async (store) => [
      await store.emailSanitizer.updateScript({
        id: id(201),
        name: 'renamed',
        script: 'src2',
        compiled: 'js2',
        enabled: true,
        appliesTo: ['msg'],
      }),
      await store.emailSanitizer.updateScript({
        id: id(299),
        name: 'x',
        script: 'x',
        compiled: null,
        enabled: true,
        appliesTo: [],
      }),
      await store.emailSanitizer.listScripts(),
    ],
  },
  {
    method: 'emailSanitizer.deleteScript',
    name: 'counted',
    fixture,
    run: async (store) => [
      await store.emailSanitizer.deleteScript(id(202)),
      await store.emailSanitizer.deleteScript(id(202)),
      (await store.emailSanitizer.listScripts()).map((s) => s.id),
    ],
  },
  {
    method: 'emailSanitizer.setScriptError',
    name: 'records and clears',
    fixture,
    run: async (store) => [
      await store.emailSanitizer.setScriptError(id(203), 'TIMEOUT: slow'),
      await store.emailSanitizer.setScriptError(id(201), null),
      await store.emailSanitizer.setScriptError(id(299), 'x'),
      (await store.emailSanitizer.listScripts()).map((s) => s.lastError),
    ],
  },
  {
    method: 'emailSanitizer.hasEnabledChatModel',
    name: 'image models and disabled ones do not count',
    fixture: {
      llm_model_configs: [
        model(1, true, { apiSurface: 'images' }),
        model(2, false, {}),
        model(3, true, { apiSurface: 'flux' }),
      ],
    },
    run: async (store) => store.emailSanitizer.hasEnabledChatModel(),
  },
  {
    method: 'emailSanitizer.hasEnabledChatModel',
    name: 'a chat model, by surface or by default',
    fixture: {
      llm_model_configs: [model(1, true, { apiSurface: 'images' }), model(2, true, {})],
    },
    run: async (store) => store.emailSanitizer.hasEnabledChatModel(),
  },
  {
    method: 'emailSanitizer.hasEnabledChatModel',
    name: 'none at all',
    run: async (store) => store.emailSanitizer.hasEnabledChatModel(),
  },
];
