import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import {
  apiSurfaceOf,
  ruleFromRow,
  ruleValues,
  scriptFromRow,
  scriptValues,
  templateFromRow,
} from './record';
import type { EmailSanitizerStore } from './types';

export function memoryEmailSanitizer(tables: MemoryTables): EmailSanitizerStore {
  return {
    async listRules() {
      return orderBy(
        tables.select('email_classifier_rules'),
        [(r) => r.priority],
        [(r) => r.id]
      ).map(ruleFromRow);
    },
    async upsertRule(rule) {
      const now = new Date();
      tables.upsert(
        'email_classifier_rules',
        { id: rule.id, ...ruleValues(rule), created_at: now, updated_at: now },
        ['id'],
        { ...ruleValues(rule), updated_at: now }
      );
    },
    async insertRules(rules) {
      const now = new Date();
      for (const rule of rules) {
        tables.insert('email_classifier_rules', {
          id: rule.id,
          ...ruleValues(rule),
          created_at: now,
          updated_at: now,
        });
      }
    },
    async deleteRule(id) {
      const wanted = id;
      return tables.delete('email_classifier_rules', (r) => r.id === wanted).length;
    },
    async listActiveTemplates() {
      return orderBy(
        tables.select('email_extraction_templates', (r) => r.status === 'active'),
        [(r) => r.sender_key],
        [(r) => r.id]
      ).map(templateFromRow);
    },
    async saveTemplateVersion({ id, senderKey, spec, matchThreshold, derivedByUpn }) {
      const [previous] = orderBy(
        tables.select(
          'email_extraction_templates',
          (r) => r.sender_key === senderKey && r.status === 'active'
        ),
        [(r) => r.version, 'desc'],
        [(r) => r.id]
      );
      const version = (previous?.version ?? 0) + 1;
      const row = {
        id,
        sender_key: senderKey,
        version,
        status: 'active',
        spec: toJson(spec),
        match_threshold: matchThreshold,
        derived_by_upn: derivedByUpn,
        superseded_at: null,
        created_at: new Date(),
      };
      if (previous) {
        tables.update('email_extraction_templates', (r) => r.id === previous.id, {
          status: 'superseded',
          superseded_at: new Date(),
        });
      }
      tables.insert('email_extraction_templates', row);
      return version;
    },
    async listScripts() {
      return orderBy(
        tables.select('email_cleaner_scripts'),
        [(r) => r.created_at],
        [(r) => r.id]
      ).map(scriptFromRow);
    },
    async insertScript(script) {
      const now = new Date();
      tables.insert('email_cleaner_scripts', {
        id: script.id,
        ...scriptValues(script),
        last_error: null,
        created_at: now,
        updated_at: now,
      });
    },
    async updateScript(script) {
      const wanted = script.id;
      return tables.update('email_cleaner_scripts', (r) => r.id === wanted, {
        ...scriptValues(script),
        last_error: null,
        updated_at: new Date(),
      }).length;
    },
    async deleteScript(id) {
      const wanted = id;
      return tables.delete('email_cleaner_scripts', (r) => r.id === wanted).length;
    },
    async setScriptError(id, error) {
      const wanted = id;
      return tables.update('email_cleaner_scripts', (r) => r.id === wanted, {
        last_error: error,
        updated_at: new Date(),
      }).length;
    },
    async hasEnabledChatModel() {
      return (
        tables.first(
          'llm_model_configs',
          (r) => r.enabled && !['images', 'flux'].includes(apiSurfaceOf(r.settings))
        ) !== undefined
      );
    },
  };
}
