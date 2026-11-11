import { groupBy, orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { boostFromRow, exemptionFromRow } from './postgres';
import type { TokenLimitStore } from './types';

export function memoryTokenLimits(tables: MemoryTables): TokenLimitStore {
  const spent = (rows: readonly { input_tokens: number; output_tokens: number }[]) =>
    rows.reduce((total, row) => total + Number(row.input_tokens) + Number(row.output_tokens), 0);

  return {
    async spentSince(subject, since) {
      const calls = tables.select(
        'llm_calls',
        (r) => r.subject === subject && r.created_at.getTime() >= since.getTime()
      );
      const rows = [...groupBy(calls, (r) => r.llm_model_id)].map(([llmModelId, group]) => ({
        llmModelId,
        tokens: spent(group),
      }));
      return orderBy(rows, [(r) => r.llmModelId === null], [(r) => r.llmModelId]);
    },
    async spentBySubjectSince(since) {
      const calls = tables.select('llm_calls', (r) => r.created_at.getTime() >= since.getTime());
      const rows = [...groupBy(calls, (r) => r.subject)].map(([subject, group]) => ({
        subject,
        tokens: spent(group),
      }));
      return orderBy(rows, [(r) => r.subject]);
    },
    async listExempt() {
      return orderBy(tables.select('token_limit_exemptions'), [(r) => r.subject]).map(
        exemptionFromRow
      );
    },
    async isExempt(subject) {
      return tables.first('token_limit_exemptions', (r) => r.subject === subject) !== undefined;
    },
    async setExempt(subject, exempt, setBy) {
      if (!exempt) {
        tables.delete('token_limit_exemptions', (r) => r.subject === subject);
        return;
      }
      tables.upsert('token_limit_exemptions', { subject, set_by: setBy, created_at: new Date() }, [
        'subject',
      ]);
    },
    async grantBoost(boost) {
      tables.insert('token_limit_boosts', {
        id: boost.id,
        subject: boost.subject,
        period: boost.period,
        tokens: String(boost.tokens),
        expires_at: boost.expiresAt,
        granted_by: boost.grantedBy,
        note: boost.note,
        created_at: new Date(),
      });
    },
    async activeBoosts(now, subject) {
      const rows = tables.select(
        'token_limit_boosts',
        (r) =>
          r.expires_at.getTime() > now.getTime() && (subject === undefined || r.subject === subject)
      );
      return orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map(boostFromRow);
    },
    async revokeBoost(id) {
      return tables.delete('token_limit_boosts', (r) => r.id === id).length > 0;
    },
  };
}
