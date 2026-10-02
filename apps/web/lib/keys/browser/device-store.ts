/**
 * Where a browser keeps the person's user key (docs/delegate-key-design.md,
 * "The user key"): IndexedDB, wrapped under a NON-EXTRACTABLE AES-GCM
 * device key that lives in the same database as a CryptoKey object. The
 * device key can be used by this origin's code in this profile and read
 * by nothing — not a script that exfiltrates IndexedDB, not a copied
 * profile on another machine without its key store — which is as far as
 * a web app can bind a secret to a device. Sign-out leaves the key here
 * so the next sign-in is silent; "Forget this device" removes it.
 *
 * Runs in the page only (there is no IndexedDB on the server); every
 * function fails soft, so a browser without storage reads as a device
 * that does not hold the key.
 */

const DB_NAME = 'renkei-keys';
const STORE = 'keys';
const VERSION = 1;

interface StoredKey {
  tenantId: string;
  deviceKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  wrapped: Uint8Array<ArrayBuffer>;
  /** The key has been shown and the person confirmed they saved it. */
  acknowledged: boolean;
}

/** A byte view as plain bytes over its own ArrayBuffer, which is what WebCrypto takes. */
function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'tenantId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function read(tenantId: string): Promise<StoredKey | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const found = await requestToPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(tenantId)
    );
    db.close();
    if (
      typeof found === 'object' &&
      found !== null &&
      'deviceKey' in found &&
      'iv' in found &&
      'wrapped' in found &&
      found.iv instanceof Uint8Array &&
      found.wrapped instanceof Uint8Array &&
      typeof found.deviceKey === 'object' &&
      found.deviceKey !== null
    ) {
      return {
        tenantId,
        deviceKey: found.deviceKey,
        iv: copy(found.iv),
        wrapped: copy(found.wrapped),
        acknowledged: 'acknowledged' in found && found.acknowledged === true,
      };
    }
    return null;
  } catch {
    db.close();
    return null;
  }
}

async function write(record: StoredKey): Promise<boolean> {
  const db = await openDatabase();
  if (!db) return false;
  try {
    const done = await requestToPromise(
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(record)
    );
    db.close();
    return done !== null;
  } catch {
    db.close();
    return false;
  }
}

/** The user key this device holds for the tenant, or null. */
export async function loadUserKey(tenantId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const record = await read(tenantId);
  if (!record) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      record.deviceKey,
      record.wrapped
    );
    const bytes = new Uint8Array(opened);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Keep the user key on this device, under a fresh non-extractable device key. */
export async function saveUserKey(
  tenantId: string,
  userKey: Uint8Array,
  options: { acknowledged?: boolean } = {}
): Promise<boolean> {
  try {
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, copy(userKey))
    );
    return write({ tenantId, deviceKey, iv, wrapped, acknowledged: options.acknowledged === true });
  } catch {
    return false;
  }
}

/** Has the person confirmed they wrote the key down? */
export async function keyAcknowledged(tenantId: string): Promise<boolean> {
  const record = await read(tenantId);
  return record?.acknowledged === true;
}

export async function acknowledgeKey(tenantId: string): Promise<void> {
  const record = await read(tenantId);
  if (record) await write({ ...record, acknowledged: true });
}

/** Forget this device: the key is gone from here; the person types it or approves from another device next time. */
export async function forgetUserKey(tenantId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(tenantId));
  } catch {
    // Nothing to forget.
  }
  db.close();
}
