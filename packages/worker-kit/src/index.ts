/**
 * Shared plumbing for Renkei's egress workers (worker-mirth, worker-onbase,
 * worker-admanager, worker-fileshares, …) — the bearer-authenticated
 * on-prem dialers the web app's SSRF guard forces every private-network
 * connector through (docs/*-connector-design.md, "the dedicated worker
 * process"). Extracted after the same handful of files proved identical,
 * copy for copy, across four independent connectors:
 *
 *  - log-encryption.ts — at-rest encryption for secure()-marked log
 *    attributes, generic, no connector knowledge at all.
 *  - logger.ts — console + Postgres/HTTP log persistence, parameterized
 *    by the worker's own name/package identity.
 *  - http.ts — the bearer-checked, size-capped JSON-over-HTTP surface
 *    (`createJsonRpcServer`) every worker's server.ts builds its `handlers`
 *    map on top of.
 *  - bootstrap.ts — `runWorker`, the `main()` every worker's index.ts calls:
 *    env parsing, the database, the port, listen, graceful shutdown.
 *
 * What deliberately stays OUT of here, in each worker's own files: the
 * connector's `WorkerErrorType` and `statusForError` (the error vocabulary
 * differs per connector), the `handlers` map (the actual business logic),
 * and the process itself — this is a shared package, not a shared runtime.
 * Each connector still ships as its own container, on its own image, so a
 * bug or an outage in one never reaches another, and a customer's firewall
 * grant can stay scoped to the one integration it was given for.
 *
 * `createWorkerLogger` (and `log-encryption.ts` underneath it) is
 * deliberately NOT re-exported from here — import it from
 * `@renkei/worker-kit/logger` instead. It reaches
 * `@campfhir/bored-logs`'s Postgres adapter, which reaches ESM-only
 * kysely helpers ts-jest cannot parse; every worker's jest config swaps
 * its own relative `./logger` import for a silent test-support mock, and
 * that trick only works if nothing else pulls the real module in through
 * a barrel re-export. `http.ts` and `bootstrap.ts` carry no such
 * baggage, so a test exercising server.ts (which needs `createJsonRpcServer`)
 * can import the bare package name safely.
 */

export {
  sendJson,
  isRecord,
  str,
  authorized,
  readBody,
  createJsonRpcServer,
  type GenericWorkerError,
  type JsonRpcHandler,
  type CreateJsonRpcServerOptions,
} from './http';
export { runWorker, type RunWorkerOptions, type WorkerServerDeps } from './bootstrap';
