/** Prompt libraries and their prompts (migration 093): plaintext templates people share. */

/** Where a library's prompts are offered: every chat's picker, or a code project's chat only. */
export type PromptLibraryScope = 'any' | 'code';

export interface PromptLibraryRecord {
  id: string;
  ownerSubject: string;
  name: string;
  description: string | null;
  scope: PromptLibraryScope;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptRecord {
  id: string;
  libraryId: string;
  title: string;
  body: string;
  position: number;
  createdBySubject: string;
  updatedBySubject: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptLibraryStore {
  get(libraryId: string): Promise<PromptLibraryRecord | null>;
  /** An owner's libraries, most recently updated first (ties by id). */
  listOwned(ownerSubject: string): Promise<PromptLibraryRecord[]>;
  /** These libraries (unknown ids left out), most recently updated first (ties by id). */
  listByIds(libraryIds: string[]): Promise<PromptLibraryRecord[]>;
  create(library: {
    ownerSubject: string;
    name: string;
    description: string | null;
    /** Defaults to 'any'. */
    scope?: PromptLibraryScope;
  }): Promise<string>;
  /** Change a library by id, bumping `updatedAt`; false when there is none. */
  update(
    libraryId: string,
    patch: { name?: string; description?: string | null; scope?: PromptLibraryScope }
  ): Promise<boolean>;
  /** Delete one of the owner's libraries (its prompts cascade). */
  delete(ownerSubject: string, libraryId: string): Promise<boolean>;
  /** A library's prompts by position, then age, then id. */
  listPrompts(libraryId: string): Promise<PromptRecord[]>;
  /** Every prompt in these libraries, by library id, then position, then id. */
  listPromptsIn(libraryIds: string[]): Promise<PromptRecord[]>;
  /** Append a prompt after the library's last (position max + 1) and bump the library; its id. */
  createPrompt(prompt: {
    libraryId: string;
    title: string;
    body: string;
    subject: string;
  }): Promise<string>;
  /** Change one of the library's prompts; bumps it and the library. False when it is not there. */
  updatePrompt(
    libraryId: string,
    promptId: string,
    patch: { title?: string; body?: string; position?: number },
    subject: string
  ): Promise<boolean>;
  /** Delete one of the library's prompts and bump the library. */
  deletePrompt(libraryId: string, promptId: string): Promise<boolean>;
}
