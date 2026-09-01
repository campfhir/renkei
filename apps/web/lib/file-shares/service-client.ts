/**
 * Re-exported from @renkei/fileshares-client, which apps/worker's
 * document-ocr-pipeline handler needs too — see that package for the real
 * implementation and its own doc comment. This file exists only to keep
 * every existing `@/lib/file-shares/service-client` import in apps/web
 * working unchanged.
 */
export * from '@renkei/fileshares-client';
