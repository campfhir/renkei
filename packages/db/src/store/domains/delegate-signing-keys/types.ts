/**
 * The deployment's instance-list signing key (delegate_signing_keys): one
 * row, the Ed25519 public half in the clear and the private half sealed
 * under the org secrets key — stored and returned sealed.
 */
export interface DelegateSigningKeyRecord {
  publicKey: string;
  sealedPrivateKey: string;
}

export interface DelegateSigningKeyStore {
  /** The key, or null before the first delegate made one. */
  find(): Promise<DelegateSigningKeyRecord | null>;
  /** Store the key unless one is already there (two boots racing keep the first); true when written. */
  insertIfAbsent(key: DelegateSigningKeyRecord): Promise<boolean>;
}
