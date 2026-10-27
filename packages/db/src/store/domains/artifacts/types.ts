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

/** A new artifact row; what is left out takes the column default. */
export interface NewArtifactRecord {
  id: string;
  ownerSubject: string;
  chatId: string | null;
  messageId: string | null;
  origin: string;
  keyKind: string;
  keyRef: string | null;
  blobKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Sealed as the caller sealed it. */
  extractedText: string | null;
  extractStatus: string;
  digestStatus: string;
}

/**
 * Fields a write may change on one artifact; absent ones stay. Every
 * write stamps updated_at, with `updatedAt` when given, else now.
 */
export interface ArtifactPatch {
  keyKind?: string;
  keyRef?: string | null;
  /** Sealed as the caller sealed it. */
  extractedText?: string | null;
  extractStatus?: string;
  digestStatus?: string;
  ocrStartedAt?: Date | null;
  ocrFinishedAt?: Date | null;
  ocrMillis?: number | null;
  ocrPages?: number | null;
  updatedAt?: Date;
}

/** An artifact with its sealed text, as a prompt inlines it. */
export interface ArtifactWithTextRecord extends ArtifactRecord {
  extractedText: string | null;
}

/** Which of a person's files in one chat a call is about. */
export interface ArtifactChatSelection {
  ownerSubject: string;
  chatId: string;
  artifactIds: string[];
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

  /** The rows of the selection, oldest first (ties by id), that still need OCR (`needs_ocr`). */
  listNeedingOcr(selection: ArtifactChatSelection): Promise<ArtifactRecord[]>;
  /**
   * The rows of the selection not yet sent with a message, with their
   * sealed text, oldest first (ties by id).
   */
  listUnsent(selection: ArtifactChatSelection): Promise<ArtifactWithTextRecord[]>;

  /** Inserts one row and returns it as stored. Rejects on a duplicate id (23505). */
  create(input: NewArtifactRecord): Promise<ArtifactRecord>;
  /** Changes one row; false when there is no such row. */
  update(artifactId: string, patch: ArtifactPatch): Promise<boolean>;
  /** The owner renames their own row; false when it is not theirs or not there. */
  rename(input: { artifactId: string; ownerSubject: string; filename: string }): Promise<boolean>;
  /** Deletes the row (its references cascade); false when there was none. */
  delete(artifactId: string): Promise<boolean>;
  /**
   * Hands the row to `newOwnerSubject`: the owner changes, the new owner's
   * own share goes (owners need none), and every other share is re-owned
   * by them. One transaction.
   */
  transferOwnership(artifactId: string, newOwnerSubject: string): Promise<void>;
  /**
   * Gives `targetId` the content of `sourceId` — bytes' key, name, type,
   * size, sealed text, extract and digest status — clears its digest
   * (summary, keywords, search terms), and deletes the source row. One
   * transaction; false (nothing changed) when either row is missing.
   */
  adoptContent(targetId: string, sourceId: string): Promise<boolean>;
  /**
   * Stores a digest — summary, keywords and the search terms the library
   * matches (keywords weighted over the summary) — as `done`; null marks
   * the digest `failed`.
   */
  storeDigest(
    artifactId: string,
    digest: { summary: string; keywords: string[] } | null
  ): Promise<void>;
  /** Gives `targetId` the digest `summary`/`keywords` and the search terms `sourceId` has, as `done`. */
  copyDigest(input: {
    targetId: string;
    sourceId: string;
    summary: string;
    keywords: string[];
  }): Promise<void>;
  /**
   * Claims one row for a digest: `pending` becomes `running`, and so does a
   * `running` last updated before `staleBefore`. False when not claimed.
   */
  claimDigest(artifactId: string, staleBefore: Date): Promise<boolean>;
  /**
   * Marks an OCR run started at `now`, unless one started at or after
   * `staleBefore` is still in flight. False when not claimed.
   */
  claimOcr(artifactId: string, now: Date, staleBefore: Date): Promise<boolean>;

  /**
   * Attaches an artifact to a project, or — already attached — sets the
   * mode, keeping the row. Returns the reference's id.
   */
  addReference(input: {
    artifactId: string;
    projectId: string;
    mode: string;
    addedBy: string;
  }): Promise<string>;
  /** False when the project does not hold the artifact. */
  setReferenceMode(input: {
    artifactId: string;
    projectId: string;
    mode: string;
  }): Promise<boolean>;
  /** Detaches; false when the project did not hold it. */
  removeReference(input: { artifactId: string; projectId: string }): Promise<boolean>;
}
