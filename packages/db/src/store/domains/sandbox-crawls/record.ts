import type { Selectable } from 'kysely';
import type { SandboxCrawlPages, SandboxCrawlRecipes, SandboxCrawls } from '../../../db.types';
import type {
  SandboxCrawlPageRecord,
  SandboxCrawlRecipeRecord,
  SandboxCrawlRecord,
  SandboxCrawlStore,
} from './types';

/** Kysely takes a JSON column as its serialized text. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function crawlFromRow(row: Selectable<SandboxCrawls>): SandboxCrawlRecord {
  return {
    id: row.id,
    subject: row.subject,
    recipeName: row.recipe_name,
    recipe: row.recipe,
    status: row.status,
    queue: row.queue,
    pagesDone: row.pages_done,
    pagesFailed: row.pages_failed,
    error: row.error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  };
}

export function crawlValues(crawl: Parameters<SandboxCrawlStore['create']>[0]) {
  return {
    ...(crawl.id !== undefined ? { id: crawl.id } : {}),
    subject: crawl.subject,
    recipe_name: crawl.recipeName,
    recipe: json(crawl.recipe),
    status: 'queued',
    queue: json(crawl.queue),
    expires_at: crawl.expiresAt,
  };
}

export function crawlPageFromRow(
  row: Pick<
    Selectable<SandboxCrawlPages>,
    | 'url'
    | 'seq'
    | 'depth'
    | 'status'
    | 'title'
    | 'content'
    | 'text_chars'
    | 'table_count'
    | 'error'
  >
): SandboxCrawlPageRecord {
  return {
    url: row.url,
    seq: row.seq,
    depth: row.depth,
    status: row.status,
    title: row.title,
    content: row.content,
    textChars: row.text_chars,
    tableCount: row.table_count,
    error: row.error,
  };
}

/** The columns a revisit of a page replaces. */
export function crawlPagePatch(page: SandboxCrawlPageRecord, at: Date) {
  return {
    status: page.status,
    title: page.title,
    content: page.content,
    text_chars: page.textChars,
    table_count: page.tableCount,
    error: page.error,
    fetched_at: at,
  };
}

export function crawlPageValues(crawlId: string, page: SandboxCrawlPageRecord, at: Date) {
  return {
    crawl_id: crawlId,
    url: page.url,
    seq: page.seq,
    depth: page.depth,
    ...crawlPagePatch(page, at),
  };
}

export function crawlRecipeFromRow(row: Selectable<SandboxCrawlRecipes>): SandboxCrawlRecipeRecord {
  return {
    name: row.name,
    recipe: row.recipe,
    lastCrawlId: row.last_crawl_id,
    updatedAt: new Date(row.updated_at),
  };
}
