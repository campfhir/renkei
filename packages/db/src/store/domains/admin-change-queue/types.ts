/** A notice about an admin change request, for one person's feed. */
export interface ChangeNotice {
  id: string;
  subject: string;
  kind: string;
  connector: string;
  entity: string;
  headline: string;
  /** The change request's id. */
  refId: string;
  /** Where it is reviewed. */
  refUrl: string;
}

/**
 * What the admin change queues (Salesforce's and Jira's) need beyond their
 * own rows: who reviews them, telling them, and naming the agent that
 * filed one.
 */
export interface AdminChangeQueueStore {
  /**
   * Every subject Renkei holds a record of with `role` — a browser
   * session or an MCP token minted while they held it — once each, by
   * subject.
   */
  operatorSubjects(role: string): Promise<string[]>;
  /** Add a notice to someone's feed (unread, now). Refuses a duplicate id. */
  recordNotice(notice: ChangeNotice): Promise<void>;
  /** The name of the agent with this id, or null when there is none. */
  agentName(agentId: string): Promise<string | null>;
}
