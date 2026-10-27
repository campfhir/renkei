/**
 * resource_access_grants: who a chat, project, prompt library or artifact
 * is shared with (migration 092). The store keeps and returns grants; the
 * rules — who may grant, which roles a kind takes, what an expired grant
 * means — stay with the callers (apps/web/lib/chat/access.ts).
 */

/** The resources a grant can name, and the table each lives in. */
export type GrantResourceKind = 'chat' | 'chat_project' | 'prompt_library' | 'artifact';

/** One grant, as stored (`role` unchecked: the caller narrows it). */
export interface ResourceGrantRecord {
  id: string;
  resourceKind: string;
  resourceId: string;
  ownerSubject: string;
  granteeSubject: string;
  role: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** A grant with the grantee's recorded name and email, for the owner's "who has access" list. */
export interface ResourceGrantWithGrantee extends ResourceGrantRecord {
  granteeName: string | null;
  granteeEmail: string | null;
}

export interface ResourceGrantStore {
  /**
   * The owner of one resource of `kind`, by id — read from the resource's
   * own table — or null when there is no such resource. The id must be a
   * uuid (a malformed one is refused, 22P02, as Postgres does).
   */
  ownerOf(kind: GrantResourceKind, resourceId: string): Promise<string | null>;
  /** The role of the grantee's unexpired grant on the resource (expires_at null or after now), or null. */
  activeRole(kind: string, resourceId: string, granteeSubject: string): Promise<string | null>;
  /** Every unexpired grant of one kind held by this person, oldest first (ties by id). */
  listForGrantee(granteeSubject: string, kind: string): Promise<ResourceGrantRecord[]>;
  /** The grantees of every unexpired grant on one resource, oldest grant first (ties by id). */
  activeGrantees(kind: string, resourceId: string): Promise<string[]>;
  /**
   * Insert a grant, or — the same resource and grantee again — refresh
   * its role and expiry in place.
   */
  upsert(grant: {
    resourceKind: string;
    resourceId: string;
    ownerSubject: string;
    granteeSubject: string;
    role: string;
    expiresAt: Date | null;
  }): Promise<void>;
  /**
   * The grants this owner made on one resource, expired ones included,
   * newest first (ties by id), each with the grantee's recorded name.
   */
  listForOwner(
    ownerSubject: string,
    kind: string,
    resourceId: string
  ): Promise<ResourceGrantWithGrantee[]>;
  /** Delete one of the owner's grants on the resource; the grantee's subject, or null when none matched. */
  revoke(
    ownerSubject: string,
    kind: string,
    resourceId: string,
    grantId: string
  ): Promise<string | null>;
  /** Delete every grant on one resource (it is gone); how many went. */
  deleteForResource(kind: string, resourceId: string): Promise<number>;
  /**
   * How many unexpired grants each of these resources has, for the ones
   * that have any, by resource id ascending.
   */
  countActive(
    kind: string,
    resourceIds: string[]
  ): Promise<{ resourceId: string; count: number }[]>;
}
