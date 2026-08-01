/**
 * Device authorization grant (RFC 8628) for CLI operator access.
 *
 * The device flow lets a CLI authenticate an operator against the tenant's OIDC
 * IdP without storing credentials. The operator signs in at a browser URL with a
 * code, and the CLI polls for the resulting ID token.
 *
 * Tokens are short-lived (issued by the IdP) and revocable through the IdP, so
 * a laptop does not hold a long-lived credential.
 *
 * **Authenticating and approving are two acts, and this class keeps them two.**
 * `POST /device/:slug/authorize` is unauthenticated, as the RFC requires, so
 * anyone can mint a device code and a matching verification link. If completing
 * the IdP round trip were itself the approval, that link would be a working
 * attack: send it to a real operator, let their existing SSO session carry them
 * through without a single prompt, and collect their ID token from the poll
 * endpoint. So `stage` records who signed in and holds the token back, and only
 * `approve` — reached by a form submission carrying a secret that exists nowhere
 * but the browser that just authenticated — releases it to the CLI.
 */

import { randomBytes } from 'node:crypto';
import type { DeviceAuthorizationRecord, GatewayStore } from './store.js';

const DEVICE_CODE_LENGTH = 32;
const USER_CODE_LENGTH = 8;
const APPROVAL_TOKEN_LENGTH = 32;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const POLLING_INTERVAL_MS = 5000; // 5 seconds

/** What a staged-but-unapproved flow tells the confirmation page to show. */
export interface StagedDevice {
  approvalToken: string;
  userCode: string;
  operator: string;
}

export class DeviceAuthManager {
  readonly #store: GatewayStore;
  readonly #now: () => Date;

  constructor(store: GatewayStore, now: () => Date) {
    this.#store = store;
    this.#now = now;
  }

  /**
   * Start a new device authorization flow for a tenant.
   */
  async initiate(tenantSlug: string): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    const now = this.#now().getTime();
    const deviceCode = randomBytes(DEVICE_CODE_LENGTH).toString('hex');
    const userCode = randomBytes(USER_CODE_LENGTH / 2)
      .toString('hex')
      .toUpperCase();

    const record: DeviceAuthorizationRecord = {
      deviceCode,
      userCode,
      tenantSlug,
      issuedAt: now,
      expiresAt: now + DEVICE_CODE_TTL_MS,
    };

    await this.#store.saveDeviceAuthorization(record);

    return {
      deviceCode,
      userCode,
      verificationUri: `/auth/device/${tenantSlug}`,
      expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: Math.floor(POLLING_INTERVAL_MS / 1000),
    };
  }

  /**
   * Get a pending device authorization by code.
   */
  async getPending(
    deviceCode: string,
    tenantSlug: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    const record = await this.#store.getDeviceAuthorization(deviceCode);
    if (!record) return null;
    if (record.tenantSlug !== tenantSlug) return null;

    const now = this.#now().getTime();
    if (now > record.expiresAt) {
      // Expired; clean up
      await this.#store.deleteDeviceAuthorization(deviceCode);
      return null;
    }

    return record;
  }

  /**
   * Look up by user code (for the sign-in page to find which device is requesting).
   *
   * Scoped to the tenant asking, because `user_code` is unique across the
   * deployment rather than per tenant. Without the check, presenting tenant B's
   * code at `/auth/device/tenant-a` would drive tenant A's operator through tenant
   * A's IdP and staple the resulting token to tenant B's flow. The token would not
   * verify at `/api/admin/tenant-b/*` — that route checks it against tenant B's
   * own IdP — so it buys an attacker nothing, but it is a cross-tenant confusion
   * that has no reason to be reachable.
   */
  async getByUserCode(
    userCode: string,
    tenantSlug: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    const record = await this.#store.getDeviceAuthorizationByUserCode(userCode);
    return record !== null && record.tenantSlug === tenantSlug ? record : null;
  }

  /**
   * The operator has authenticated. Record the token, but do not release it.
   *
   * Returns the handle for the confirmation form. The ID token is now in the row
   * and still unreachable by the CLI, because `token()` checks `approvedAt` and
   * nothing here sets it.
   */
  async stage(
    deviceCode: string,
    tenantSlug: string,
    operatorSubject: string,
    idToken: string,
    operator: string,
  ): Promise<StagedDevice> {
    const record = await this.getPending(deviceCode, tenantSlug);
    if (!record) throw new Error('Device code not found or expired');
    if (record.approvedAt !== undefined) throw new Error('Device code already approved');

    const approvalToken = randomBytes(APPROVAL_TOKEN_LENGTH).toString('hex');

    await this.#store.saveDeviceAuthorization({
      ...record,
      operatorSubject,
      idToken,
      approvalToken,
    });

    return { approvalToken, userCode: record.userCode, operator };
  }

  /** The staged flow behind a confirmation handle, or null if there is none. */
  async getStaged(
    approvalToken: string,
    tenantSlug: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    const record = await this.#store.getDeviceAuthorizationByApprovalToken(approvalToken);
    if (!record) return null;
    if (record.tenantSlug !== tenantSlug) return null;

    if (this.#now().getTime() > record.expiresAt) {
      await this.#store.deleteDeviceAuthorization(record.deviceCode);
      return null;
    }

    if (record.approvedAt !== undefined) return null;

    return record;
  }

  /**
   * The operator confirmed. Release the token to the CLI.
   *
   * Clearing `approvalToken` is what makes the confirmation single-use: a
   * resubmitted form finds no staged flow rather than re-approving one.
   */
  async approve(
    approvalToken: string,
    tenantSlug: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    const record = await this.getStaged(approvalToken, tenantSlug);
    if (!record) return null;

    const approved: DeviceAuthorizationRecord = {
      ...record,
      approvedAt: this.#now().getTime(),
    };
    delete approved.approvalToken;

    await this.#store.saveDeviceAuthorization(approved);
    return approved;
  }

  /**
   * The operator declined, or did not recognize the code.
   *
   * Deletes the row outright: the CLI's next poll gets `expired_token` and stops,
   * which is the honest answer — this device is never getting a token.
   */
  async deny(approvalToken: string, tenantSlug: string): Promise<DeviceAuthorizationRecord | null> {
    const record = await this.getStaged(approvalToken, tenantSlug);
    if (!record) return null;

    await this.#store.deleteDeviceAuthorization(record.deviceCode);
    return record;
  }

  /**
   * Poll for the ID token. Returns the token if approved, or an error code.
   */
  async token(
    deviceCode: string,
    tenantSlug: string,
  ): Promise<
    | { accessToken: string; expiresIn: number }
    | { error: 'authorization_pending' | 'expired_token' }
  > {
    const record = await this.getPending(deviceCode, tenantSlug);
    if (!record) {
      return { error: 'expired_token' };
    }

    // Unapproved, or approved without a token to hand over: either way the CLI
    // has nothing to collect, and `authorization_pending` is what tells it to
    // keep waiting rather than to report a failure.
    if (record.approvedAt === undefined || record.idToken === undefined) {
      return { error: 'authorization_pending' };
    }

    return {
      accessToken: record.idToken,
      expiresIn: 3600, // 1 hour
    };
  }
}
