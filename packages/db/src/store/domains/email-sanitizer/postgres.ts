import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '../../../db.types';
import { ruleFromRow, ruleValues, scriptFromRow, scriptValues, templateFromRow } from './record';
import type { EmailSanitizerStore } from './types';

/** The SQL twin of @renkei/agent-llm's chatModelsOnly (this package cannot import it). */
const chatModelsOnly = sql<SqlBool>`coalesce(settings->>'apiSurface', '') not in ('images', 'flux')`;

export function postgresEmailSanitizer(db: () => Kysely<DB>): EmailSanitizerStore {
  return {
    async listRules() {
      const rows = await db()
        .selectFrom('email_classifier_rules')
        .selectAll()
        .orderBy('priority', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(ruleFromRow);
    },
    async upsertRule(rule) {
      await db()
        .insertInto('email_classifier_rules')
        .values({
          id: rule.id,
          ...ruleValues(rule),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({ ...ruleValues(rule), updated_at: new Date().toISOString() })
        )
        .execute();
    },
    async insertRules(rules) {
      if (rules.length === 0) return;
      await db()
        .insertInto('email_classifier_rules')
        .values(
          rules.map((rule) => ({
            id: rule.id,
            ...ruleValues(rule),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }))
        )
        .execute();
    },
    async deleteRule(id) {
      const result = await db()
        .deleteFrom('email_classifier_rules')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async listActiveTemplates() {
      const rows = await db()
        .selectFrom('email_extraction_templates')
        .selectAll()
        .where('status', '=', 'active')
        .orderBy('sender_key')
        .orderBy('id')
        .execute();
      return rows.map(templateFromRow);
    },
    async saveTemplateVersion({ id, senderKey, spec, matchThreshold, derivedByUpn }) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const previous = await trx
            .selectFrom('email_extraction_templates')
            .select(['id', 'version'])
            .where('sender_key', '=', senderKey)
            .where('status', '=', 'active')
            .orderBy('version', 'desc')
            .orderBy('id')
            .executeTakeFirst();
          if (previous) {
            await trx
              .updateTable('email_extraction_templates')
              .set({ status: 'superseded', superseded_at: sql<Date>`NOW()` })
              .where('id', '=', previous.id)
              .execute();
          }
          const version = (previous?.version ?? 0) + 1;
          await trx
            .insertInto('email_extraction_templates')
            .values({
              id,
              sender_key: senderKey,
              version,
              status: 'active',
              spec: JSON.stringify(spec),
              match_threshold: matchThreshold,
              derived_by_upn: derivedByUpn,
            })
            .execute();
          return version;
        });
    },
    async listScripts() {
      const rows = await db()
        .selectFrom('email_cleaner_scripts')
        .selectAll()
        .orderBy('created_at', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(scriptFromRow);
    },
    async insertScript(script) {
      await db()
        .insertInto('email_cleaner_scripts')
        .values({ id: script.id, ...scriptValues(script) })
        .execute();
    },
    async updateScript(script) {
      const result = await db()
        .updateTable('email_cleaner_scripts')
        .set({
          ...scriptValues(script),
          // An edited script starts with a clean bill of health — its old
          // error described code that no longer exists.
          last_error: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', script.id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async deleteScript(id) {
      const result = await db()
        .deleteFrom('email_cleaner_scripts')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async setScriptError(id, error) {
      const result = await db()
        .updateTable('email_cleaner_scripts')
        .set({ last_error: error, updated_at: sql`now()` })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async hasEnabledChatModel() {
      const row = await db()
        .selectFrom('llm_model_configs')
        .select('id')
        .where('enabled', '=', true)
        .where(chatModelsOnly)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
