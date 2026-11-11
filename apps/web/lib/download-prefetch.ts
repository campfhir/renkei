/**
 * The header a download link sends when it fetches a file AHEAD of a tap
 * (components/download-link.tsx: an iOS home-screen app needs the bytes in
 * hand before the share sheet may open). A route whose download is an audit
 * event reads it to tell "fetched in case" from "taken": the fetch ahead
 * is audited as prepared (the bytes reached the device; whether they were
 * kept is not known), and the link reports the tap itself with a POST to
 * the same address, which is audited as the export.
 */
export const DOWNLOAD_PREFETCH_HEADER = 'x-renkei-prefetch';

export function isDownloadPrefetch(request: Request): boolean {
  return request.headers.get(DOWNLOAD_PREFETCH_HEADER) === '1';
}
