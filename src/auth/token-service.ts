/**
 * Authentication abstraction — spec §4.
 * Two models: private-app token (single account) and OAuth (multi-tenant).
 * Tokens come from a CredentialStore (secrets manager in production); they are
 * never logged and never appear in errors.
 */

export interface AccessTokenProvider {
  /** Returns a currently valid access token. */
  getToken(): Promise<string>;
  /** Invalidate cache and refresh; called after an authorized 401. Throws AuthorizationRequiredError if refresh fails. */
  refresh(): Promise<string>;
}

export class AuthorizationRequiredError extends Error {
  constructor(public readonly connectorId: string) {
    super(`Connector ${connectorId} requires re-authorization`);
    this.name = "AuthorizationRequiredError";
  }
}

/** §4.1 — one known HubSpot account. */
export class PrivateAppTokenProvider implements AccessTokenProvider {
  constructor(private readonly readSecret: () => Promise<string>) {}

  async getToken(): Promise<string> {
    return this.readSecret();
  }

  async refresh(): Promise<string> {
    // Private-app tokens are static; a 401 means the token was revoked.
    throw new AuthorizationRequiredError("private-app");
  }
}

export interface OAuthCredentialStore {
  readRefreshToken(connectorId: string): Promise<string | null>;
  writeAccessToken(connectorId: string, token: string, expiresAt: number): Promise<void>;
}

export interface OAuthTokenExchanger {
  /** POST /oauth/v1/token grant_type=refresh_token. Returns null when the refresh token is revoked. */
  exchangeRefreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresInSeconds: number } | null>;
}

/** §4.3 — OAuth lifecycle: cache short-lived token, refresh before expiry or on 401. */
export class OAuthTokenProvider implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  /** Refresh this many ms before actual expiry. */
  private static readonly EXPIRY_MARGIN_MS = 60_000;

  constructor(
    private readonly connectorId: string,
    private readonly store: OAuthCredentialStore,
    private readonly exchanger: OAuthTokenExchanger,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - OAuthTokenProvider.EXPIRY_MARGIN_MS > this.now()) {
      return this.cached.token;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const refreshToken = await this.store.readRefreshToken(this.connectorId);
    if (!refreshToken) throw new AuthorizationRequiredError(this.connectorId);

    const result = await this.exchanger.exchangeRefreshToken(refreshToken);
    if (!result) throw new AuthorizationRequiredError(this.connectorId);

    const expiresAt = this.now() + result.expiresInSeconds * 1000;
    this.cached = { token: result.accessToken, expiresAt };
    await this.store.writeAccessToken(this.connectorId, result.accessToken, expiresAt);
    return result.accessToken;
  }
}
