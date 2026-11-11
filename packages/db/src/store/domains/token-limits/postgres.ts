import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, TokenLimitBoosts, TokenLimitExemptions } from '../../../db.types';
import type { TokenLimitBoostRecord, TokenLimitExemptionRecord, TokenLimitStore } from './types';

export function exemptionFromRow(row: Selectable<TokenLimitExemptions>): TokenLimitExemptionRecord {
  return { subject: row.subject, setBy: row.set_by, createdAt: new Date(row.created_at) };
}

export function boostFromRow(row: Selectable<TokenLimitBoosts>): TokenLimitBoostRecord {
  return {
    id: row.id,
    subject: row.subject,
    period: row.period === 'month' ? 'month' : 'week',
    tokens: Number(row.tokens),
    expiresAt: new Date(row.expires_at),
    grantedBy: row.granted_by,
    note: row.note,
    createdAt: new Date(row.created_at),
  };
}

export function postgresTokenLimits(db: () => Kysely<DB>): TokenLimitStore {
  return {
    async spentSince(subject, since) {
      const rows = await db()
        .selectFrom('llm_calls')
        .select(['llm_model_id', sql<string>`SUM(input_tokens + output_tokens)`.as('tokens')])
        .where('subject', '=', subject)
        .where('created_at', '>=', since)
        .groupBy('llm_model_id')
        .orderBy(sql`llm_model_id ASC NULLS LAST`)
        .execute();
      return rows.map((row) => ({ llmModelId: row.llm_model_id, tokens: Number(row.tokens) }));
    },
    async spentBySubjectSince(since) {
      const rows = await db()
        .selectFrom('llm_calls')
        .select(['subject', sql<string>`SUM(input_tokens + output_tokens)`.as('tokens')])
        .where('created_at', '>=', since)
        .groupBy('subject')
        .orderBy('subject')
        .execute();
      return rows.map((row) => ({ subject: row.subject, tokens: Number(row.tokens) }));
    },
    async listExempt() {
      const rows = await db()
        .selectFrom('token_limit_exemptions')
        .selectAll()
        .orderBy('subject')
        .execute();
      return rows.map(exemptionFromRow);
    },
    async isExempt(subject) {
      const row = await db()
        .selectFrom('token_limit_exemptions')
        .select('subject')
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row !== undefined;
    },
    async setExempt(subject, exempt, setBy) {
      if (!exempt) {
        await db().deleteFrom('token_limit_exemptions').where('subject', '=', subject).execute();
        return;
      }
      await db()
        .insertInto('token_limit_exemptions')
        .values({ subject, set_by: setBy })
        .onConflict((conflict) => conflict.column('subject').doNothing())
        .execute();
    },
    async grantBoost(boost) {
      await db()
        .insertInto('token_limit_boosts')
        .values({
          id: boost.id,
          subject: boost.subject,
          period: boost.period,
          tokens: boost.tokens,
          expires_at: boost.expiresAt,
          granted_by: boost.grantedBy,
          note: boost.note,
        })
        .execute();
    },
    async activeBoosts(now, subject) {
      let query = db()
        .selectFrom('token_limit_boosts')
        .selectAll()
        .where('expires_at', '>', now)
        .orderBy('created_at')
        .orderBy('id');
      if (subject !== undefined) query = query.where('subject', '=', subject);
      return (await query.execute()).map(boostFromRow);
    },
    async revokeBoost(id) {
      const result = await db()
        .deleteFrom('token_limit_boosts')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
