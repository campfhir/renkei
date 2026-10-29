/**
 * The email sanitizer's org-wide, content-free policy: classifier rules,
 * extraction templates and cleaner scripts. Category, match type, status
 * and kinds are the stored strings; @renkei/email-sanitizer narrows them.
 */
export interface ClassifierRuleRecord {
  id: string;
  category: string;
  matchType: string;
  matchValue: string;
  senderKey: string | null;
  priority: number;
  enabled: boolean;
}

export interface ExtractionTemplateRecord {
  id: string;
  senderKey: string;
  version: number;
  status: string;
  /** The template's segments, parsed. */
  spec: unknown;
  matchThreshold: number;
}

export interface CleanerScriptRecord {
  id: string;
  name: string;
  script: string;
  compiled: string | null;
  enabled: boolean;
  appliesTo: string[];
  lastError: string | null;
}

export interface EmailSanitizerStore {
  /** Every rule by priority (ties by id). */
  listRules(): Promise<ClassifierRuleRecord[]>;
  /** Insert or replace one rule by id. */
  upsertRule(rule: ClassifierRuleRecord): Promise<void>;
  /** Several new rules, all or none. */
  insertRules(rules: ClassifierRuleRecord[]): Promise<void>;
  deleteRule(id: string): Promise<number>;
  /** Every active template, by sender key (ties by id). */
  listActiveTemplates(): Promise<ExtractionTemplateRecord[]>;
  /**
   * A new active version for a sender, superseding the active one; returns
   * the version it was given (one past the superseded one, or 1).
   */
  saveTemplateVersion(template: {
    id: string;
    senderKey: string;
    spec: unknown;
    matchThreshold: number;
    derivedByUpn: string;
  }): Promise<number>;
  /** Every script in creation order (ties by id). */
  listScripts(): Promise<CleanerScriptRecord[]>;
  insertScript(script: Omit<CleanerScriptRecord, 'lastError'>): Promise<void>;
  /** Replace a script's source and settings, clearing its last error; returns rows changed. */
  updateScript(script: Omit<CleanerScriptRecord, 'lastError'>): Promise<number>;
  deleteScript(id: string): Promise<number>;
  /** Record (or clear, null) a script's last run error; returns rows changed. */
  setScriptError(id: string, error: string | null): Promise<number>;
  /**
   * Whether any enabled model configuration generates chat — not images
   * (settings.apiSurface 'images' or 'flux'). The sanitizer's suggestions
   * need one; its admin page offers them only then.
   */
  hasEnabledChatModel(): Promise<boolean>;
}
