import type { UserKeySealedTable } from './types';

/**
 * Where each table sealed for a person keeps them: the column naming the
 * person, the columns that identify a row (in order), and the sealed
 * columns. Add a table here (and to UserKeySealedTable) when a new column
 * is sealed for a subject; @renkei/user-keys says which key it goes under.
 */
export const USER_KEY_SEALED_TABLES: Readonly<
  Record<
    UserKeySealedTable,
    {
      subjectColumn: 'subject' | 'owner_subject';
      idColumns: readonly string[];
      columns: readonly string[];
    }
  >
> = {
  provider_grants: {
    subjectColumn: 'subject',
    idColumns: ['provider', 'provider_account_id'],
    columns: ['encrypted_access_token', 'encrypted_refresh_token'],
  },
  mirth_instance_connections: {
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
  },
  admanager_instance_connections: {
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
  },
  file_share_connections: {
    subjectColumn: 'subject',
    idColumns: ['share_id'],
    columns: ['encrypted_credentials'],
  },
  chat_user_memories: {
    subjectColumn: 'owner_subject',
    idColumns: ['id'],
    columns: ['content'],
  },
};

/** The tables in the order a change of keys walks them. */
export const USER_KEY_SEALED_ORDER: readonly UserKeySealedTable[] = [
  'provider_grants',
  'mirth_instance_connections',
  'admanager_instance_connections',
  'file_share_connections',
  'chat_user_memories',
];
