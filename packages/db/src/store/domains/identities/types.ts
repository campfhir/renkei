/** Who a subject is, as recorded at their latest sign-in. */
export interface IdentityRecord {
  subject: string;
  email: string;
  displayName: string | null;
  idpGroups: string[];
}

export interface IdentityStore {
  get(subject: string): Promise<IdentityRecord | null>;
  /** Insert, or replace email, name and groups of an existing subject. */
  upsert(identity: IdentityRecord): Promise<void>;
  /** Empty a subject's groups; a subject with no row is left alone. */
  clearGroups(subject: string): Promise<void>;
  /** Everyone, by display name then email, ascending; a missing name sorts last. */
  list(): Promise<IdentityRecord[]>;
  /** The recorded ones among these subjects, by subject. Unknown subjects are left out. */
  listBySubjects(subjects: string[]): Promise<IdentityRecord[]>;
  /** Every distinct group value anyone carried at sign-in, ascending. */
  distinctGroups(): Promise<string[]>;
  /** The subject recorded with exactly this email (the first by subject when several), or null. */
  subjectByEmail(email: string): Promise<string | null>;
}
