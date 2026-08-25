/**
 * The banner phrase library folds into cleaner scripts.
 *
 * Two authoring surfaces did one job: a phrase list that strips literal
 * gateway banners, and sandboxed scripts that strip anything. Scripts
 * subsume phrases, so the list goes — but the ROWS in it do not simply get
 * dropped. Those phrases are something an admin typed, tenant by tenant,
 * after reading their own mail; deleting a table is our decision to make,
 * deleting their work is not.
 *
 * So every tenant holding enabled phrases gets a generated script that does
 * exactly what the library did for them, and only then is the table
 * dropped. The script is an ordinary row from that moment on: readable on
 * the admin page, editable, disableable, deletable.
 *
 * The two built-in SEED_BANNERS are deliberately NOT carried over. They
 * were our opinion applied to everyone; a tenant that wants them can add
 * them to their own script, and a tenant that never had a banner problem no
 * longer runs a stripper for it.
 *
 * Phrases are embedded via JSON.stringify rather than string concatenation
 * — a phrase containing a quote or a backslash would otherwise produce a
 * script that does not parse, and the first anyone would know of it is a
 * `last_error` on a row nobody was watching.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

/**
 * The generated source. Matches word-by-word with `\s+` between words,
 * which is the same technique the phrase library used: a mail client can
 * re-wrap a banner across lines, and a match anchored to exact whitespace
 * would silently stop firing when it did.
 */
function scriptFor(phrases: readonly string[]): string {
  return `(email) => {
  // Generated from this organization's external-sender banner library when
  // that library folded into cleaner scripts. Edit freely — add a phrase by
  // adding a string, remove one by deleting it.
  const phrases = ${JSON.stringify(phrases, null, 2)};
  let text = email.text;
  for (const phrase of phrases) {
    const words = phrase.trim().split(/\\s+/).map((word) => word.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'));
    if (words.length === 0) continue;
    text = text.replace(new RegExp(words.join('\\\\s+'), 'gi'), '');
  }
  return text.trim();
}`;
}

interface PhraseRow {
  tenant_id: string;
  phrase: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<PhraseRow>`
    SELECT tenant_id, phrase
    FROM email_banner_patterns
    WHERE enabled = true
    ORDER BY tenant_id, created_at
  `.execute(db);

  const byTenant = new Map<string, string[]>();
  for (const row of existing.rows) {
    const phrase = row.phrase?.trim();
    if (!phrase) continue;
    const list = byTenant.get(row.tenant_id) ?? [];
    list.push(phrase);
    byTenant.set(row.tenant_id, list);
  }

  for (const [tenantId, phrases] of byTenant) {
    await sql`
      INSERT INTO email_cleaner_scripts (id, tenant_id, name, script, enabled, applies_to)
      VALUES (
        ${randomUUID()},
        ${tenantId},
        ${'External-sender banners'},
        ${scriptFor(phrases)},
        true,
        ARRAY['msg']
      )
    `.execute(db);
  }

  await db.schema.dropTable('email_banner_patterns').execute();
}

/**
 * Recreates the table and refills it by parsing the generated script back
 * out — the phrases are a JSON array literal in the source precisely so
 * this direction is possible. A tenant whose script was edited by hand
 * since the migration will not round-trip; that is recorded here rather
 * than papered over, because a down migration that quietly loses edits is
 * worse than one that is honest about its limits.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('email_banner_patterns')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('phrase', 'text', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_email_banner_patterns_tenant')
    .on('email_banner_patterns')
    .columns(['tenant_id'])
    .execute();

  const generated = await sql<{ tenant_id: string; script: string }>`
    SELECT tenant_id, script
    FROM email_cleaner_scripts
    WHERE name = ${'External-sender banners'}
  `.execute(db);

  for (const row of generated.rows) {
    const match = /const phrases = (\[[\s\S]*?\]);/.exec(row.script);
    if (!match) continue;
    let phrases: unknown;
    try {
      phrases = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(phrases)) continue;
    for (const phrase of phrases) {
      if (typeof phrase !== 'string' || !phrase.trim()) continue;
      await sql`
        INSERT INTO email_banner_patterns (id, tenant_id, phrase, enabled)
        VALUES (${randomUUID()}, ${row.tenant_id}, ${phrase}, true)
      `.execute(db);
    }
  }

  await sql`
    DELETE FROM email_cleaner_scripts WHERE name = ${'External-sender banners'}
  `.execute(db);
}
