import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
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
  const ruleId = (id: string) => tables.param('email_classifier_rules', 'id', id);
  const scriptId = (id: string) => tables.param('email_cleaner_scripts', 'id', id);
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
      tables.insertMany(
        'email_classifier_rules',
        rules.map((rule) => ({
          id: rule.id,
          ...ruleValues(rule),
          created_at: now,
          updated_at: now,
        }))
      );
    },
    async deleteRule(id) {
      const wanted = ruleId(id);
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
        spec: JSON.stringify(spec),
        match_threshold: matchThreshold,
        derived_by_upn: derivedByUpn,
      };
      // All or nothing, as the Postgres transaction is: a taken id makes
      // the insert refuse (23505) — let it refuse here, before the
      // supersede changes anything.
      const newId = tables.param('email_extraction_templates', 'id', id);
      if (tables.first('email_extraction_templates', (r) => r.id === newId)) {
        tables.insert('email_extraction_templates', row);
      }
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
      tables.insert('email_cleaner_scripts', { id: script.id, ...scriptValues(script) });
    },
    async updateScript(script) {
      const wanted = scriptId(script.id);
      return tables.update('email_cleaner_scripts', (r) => r.id === wanted, {
        ...scriptValues(script),
        last_error: null,
        updated_at: new Date(),
      }).length;
    },
    async deleteScript(id) {
      const wanted = scriptId(id);
      return tables.delete('email_cleaner_scripts', (r) => r.id === wanted).length;
    },
    async setScriptError(id, error) {
      const wanted = scriptId(id);
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
