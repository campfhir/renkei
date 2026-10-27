/**
 * Artifacts — the files people upload and their chats produce — and the
 * projects that hold them (artifact_references), as the chat and the
 * library read them (migrations 163, 164, 167). The extracted text comes
 * back only through `getText`, sealed as stored; who may see a row is
 * apps/web/lib/chat/artifact-access.ts's decision.
 */

export interface ArtifactRecord {
  id: string;
  ownerSubject: string;
  chatId: string | null;
  messageId: string | null;
  blobKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
  origin: string;
  keyKind: string;
  keyRef: string | null;
  summary: string | null;
  keywords: string[];
  digestStatus: string;
  ocrStartedAt: Date | null;
  ocrFinishedAt: Date | null;
  ocrPages: number | null;
  ocrMillis: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An artifact as one project holds it. */
export interface ProjectArtifactRecord extends ArtifactRecord {
  referenceId: string;
  mode: string;
  addedBy: string;
}

export type LibraryShowFilter = 'all' | 'uploaded' | 'generated' | 'shared';

/**
 * Which rows of a person's library a page shows: theirs and the ones
 * shared with them (`sharedIds`), narrowed by kind, project and words.
 */
export interface LibraryFilter {
  viewerSubject: string;
  sharedIds: string[];
  show: LibraryShowFilter;
  projectId: string | null;
  /**
   * The search as typed, matched against the digest with Postgres's
   * websearch_to_tsquery('english'); empty when `terms` is empty.
   */
  query: string;
  /** The words of the search, each required in the filename (case-insensitive substring). */
  terms: string[];
}

export interface ArtifactStore {
  get(artifactId: string): Promise<ArtifactRecord | null>;
  /** These artifacts (unknown ids left out), oldest first (ties by id). */
  getMany(artifactIds: string[]): Promise<ArtifactRecord[]>;
  /** The files of one chat, oldest first (ties by id); `origin` narrows to uploads or model files. */
  listByChat(chatId: string, options?: { origin?: string }): Promise<ArtifactRecord[]>;
  /**
   * One of the owner's files in a chat, by id or else by filename (the
   * newest of that name, ties by id), or null.
   */
  findInChat(input: {
    chatId: string;
    ownerSubject: string;
    id: string | null;
    filename: string | null;
  }): Promise<ArtifactRecord | null>;
  /** The sealed extracted text, or null when there is none (or no such artifact). */
  getText(artifactId: string): Promise<string | null>;
  /** The length of each one's extracted text (0 without), by id ascending. */
  textLengths(artifactIds: string[]): Promise<{ id: string; chars: number }[]>;
  /**
   * The text length of each artifact the project holds in `always` mode,
   * `exceptId` left out, by artifact id.
   */
  alwaysTextLengths(
    projectId: string,
    exceptId: string | null
  ): Promise<{ id: string; chars: number }[]>;
  /** The artifacts one project holds, in the order they were attached (ties by reference id). */
  listForProject(projectId: string): Promise<ProjectArtifactRecord[]>;
  getForProject(projectId: string, artifactId: string): Promise<ProjectArtifactRecord | null>;
  /** The projects holding one artifact, in the order it was attached (ties by reference id). */
  listReferences(
    artifactId: string
  ): Promise<{ referenceId: string; projectId: string; mode: string; addedBy: string }[]>;
  /** How many projects hold each of these, for the ones held anywhere, by artifact id. */
  referenceCounts(artifactIds: string[]): Promise<{ artifactId: string; count: number }[]>;
  /**
   * Every project holding each of these artifacts, with the project's
   * name and kind, in the order attached (ties by reference id).
   */
  projectsUsing(
    artifactIds: string[]
  ): Promise<{ artifactId: string; mode: string; projectId: string; name: string; kind: string }[]>;
  /** A person's own files, newest first (ties by id). */
  listOwned(ownerSubject: string): Promise<ArtifactRecord[]>;
  /** Timings of the latest finished OCR runs org-wide (newest finish first, ties by id). */
  ocrSamples(limit: number): Promise<{ sizeBytes: number; millis: number }[]>;
  /** How many rows the filter admits. */
  libraryCount(filter: LibraryFilter): Promise<number>;
  /**
   * One page of the rows the filter admits: the viewer's own first, then
   * shared; each newest first, ties by id.
   */
  libraryRows(
    filter: LibraryFilter,
    page: { limit: number; offset: number }
  ): Promise<ArtifactRecord[]>;
  /**
   * How many admitted rows sort before `focusId` — owned rows newer than
   * it when it is owned; every owned row and newer shared ones when it is
   * shared — or null when the filter does not admit it.
   */
  libraryPosition(filter: LibraryFilter, focusId: string): Promise<number | null>;
  /** How many files a person owns and how many bytes they hold. */
  ownedTotals(ownerSubject: string): Promise<{ count: number; bytes: number }>;
  /** How many of these ids are artifacts that exist. */
  countExisting(artifactIds: string[]): Promise<number>;
}
