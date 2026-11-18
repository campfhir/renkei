/**
 * CI building blocks (migration 183): a block's row, carrying the draft
 * being edited, and its published versions, which never change. The
 * definition is JSON the store keeps as given — @renkei/ci-blocks reads
 * and checks it. A key already taken is refused with 23505.
 */

export interface CiBlockRecord {
  id: string;
  /** How a pipeline names the block: `deploy-systemd`. */
  key: string;
  name: string;
  description: string | null;
  kind: string;
  /** The definition being edited; null when nothing is unpublished. */
  draft: unknown;
  /** The newest published version; 0 before the first. */
  latestVersion: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CiBlockVersionRecord {
  blockId: string;
  version: number;
  definition: unknown;
  publishedBy: string;
  publishedAt: Date;
}

export interface CiBlockStore {
  /** Every block, by name (ties by id). */
  list(): Promise<CiBlockRecord[]>;
  get(id: string): Promise<CiBlockRecord | null>;
  getByKey(key: string): Promise<CiBlockRecord | null>;
  /** A new block, its definition a draft until published. */
  create(input: {
    key: string;
    name: string;
    description: string | null;
    kind: string;
    draft: unknown;
    createdBy: string;
  }): Promise<string>;
  /** Replace the draft and what the list shows; false when there is no such block. */
  saveDraft(
    id: string,
    input: { name: string; description: string | null; kind: string; draft: unknown }
  ): Promise<boolean>;
  /** Drop the draft, back to the latest published version; false when there was none. */
  discardDraft(id: string): Promise<boolean>;
  /**
   * The draft becomes the next version, at once: written, the draft
   * cleared, `latestVersion` moved on. The new version's number; null when
   * there is no such block or nothing to publish.
   */
  publish(id: string, publishedBy: string): Promise<number | null>;
  /** A block's versions, newest first. */
  listVersions(id: string): Promise<CiBlockVersionRecord[]>;
  getVersion(id: string, version: number): Promise<CiBlockVersionRecord | null>;
  /** The block and every version of it. */
  delete(id: string): Promise<boolean>;
}
