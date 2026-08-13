/**
 * The Renkei embedding worker — the other half of Decision #20, consuming
 * the `embedding_jobs` queue.
 *
 * Everything network-bound against the org-configured embeddings endpoint
 * lives here: chunk-and-embed ingestion, index deletes and purges, and the
 * asynchronous related-items back-fill on actionable items. The endpoint is
 * arbitrary org infrastructure — when it is slow, this process is slow, and
 * nothing else is: the interactive worker never waits on it.
 *
 * Scale this process horizontally at will: claims are row-locked, and the
 * ordering keys producers set (per mailbox, per object) keep
 * purge/ingest/delete sequences serial regardless of instance count.
 *
 * No sweeps run here; those stay with the interactive worker. This process
 * is a pure queue consumer.
 */

import { closeDatabase } from '@renkei/db';
import { embeddingQueue } from './queue';
import { handlerFor, registerHandler } from './handlers';
import { createEventLoop } from './loop';
import { KNOWLEDGE_SOURCE } from './enqueue';
import {
  createKnowledgeIngestObjectHandler,
  createKnowledgeIngestEmailHandler,
  createKnowledgeIngestDocumentHandler,
  createKnowledgeDeleteObjectHandler,
  createKnowledgePurgePrefixHandler,
  createKnowledgeReconcileDriveHandler,
  createKnowledgeEnrichItemHandler,
} from './handlers/knowledge-ingest';
import { logger, attachPersistentLogging } from './logger';

function registerKnowledgeHandlers(): void {
  registerHandler(KNOWLEDGE_SOURCE, 'ingest.object', createKnowledgeIngestObjectHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'ingest.email', createKnowledgeIngestEmailHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'ingest.document', createKnowledgeIngestDocumentHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'delete.object', createKnowledgeDeleteObjectHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'purge.prefix', createKnowledgePurgePrefixHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'reconcile.drive', createKnowledgeReconcileDriveHandler());
  registerHandler(KNOWLEDGE_SOURCE, 'enrich.item', createKnowledgeEnrichItemHandler());
  logger.info('knowledge handlers registered', { component: 'worker/embeddings-loop' });
}

const loop = createEventLoop({
  claim: () => embeddingQueue.consumer.claim(),
  complete: (event) => embeddingQueue.consumer.complete(event),
  fail: (event, error) => embeddingQueue.consumer.fail(event, error),
  handlerFor,
  label: 'worker/embeddings-loop',
});

async function main(): Promise<void> {
  await attachPersistentLogging();
  registerKnowledgeHandlers();
  logger.info('started {application} {version} (embedding queue)', {
    component: 'worker/embeddings-loop',
  });
  await loop.run();
  logger.info('stopped', { component: 'worker/embeddings-loop' });
  await logger.flush();
  await closeDatabase();
}

function shutdown(signal: string): void {
  logger.info('{signal} received, finishing current event', {
    component: 'worker/embeddings-loop',
    signal,
  });
  loop.stop();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
