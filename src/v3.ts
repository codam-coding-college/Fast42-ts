import { Method, RetryConfig, TOKEN_EXPIRY_BUFFER_S, parseOptions, resolveRetry, runWithRetry } from './shared.js';

/**
 * The Intra v3 API is not a single versioned host like v2. It is a collection of independent
 * microservices, each on its own host with its own internal version, e.g.:
 *   - Paced System:      https://pace-system.42.fr/api/v1
 *   - Freezes:           https://freeze.42.fr/api/v2
 *   - Chronos:           https://chronos.42.fr/api/v1
 *   - Alumni Management: https://alumni-management.42.fr/api/v1
 *
 * All calls therefore take the service subdomain and its version explicitly, and a URL is built as
 *   https://<service>.42.fr/api/<version>/<endpoint>
 *
 * Authentication is completely separate from v2: v3 uses an OIDC (Keycloak) provider with the
 * Resource Owner Password Credentials grant (username/password, optionally a one-time TOTP for 2FA)
 * and refresh tokens, rather than v2's client_credentials grant. v3 has no documented rate limits,
 * so there is no Bottleneck limiter here; requests go straight through (still with 429/5xx retries).
 */

/** Default OIDC token endpoint (staff-42 Keycloak realm). */
const DEFAULT_TOKEN_URL = 'https://auth.42.fr/auth/realms/staff-42/protocol/openid-connect/token'

export interface Fast42v3Config {
  /** OIDC client id (OIDC_RP_CLIENT_ID). */
  clientId: string;
  /** OIDC client secret (OIDC_RP_CLIENT_SECRET). */
  clientSecret: string;
  /** 42 username, used for the initial password (ROPC) grant. */
  username: string;
  /** 42 password, used for the initial password (ROPC) grant. */
  password: string;
  /**
   * One-time TOTP code. Only required if the account has 2FA enabled, and only consumed by the
   * initial password grant. TOTP codes are single-use, so if the refresh token later expires you
   * must supply a fresh code via refreshToken(totp).
   */
  totp?: string;
  /** Override the OIDC token endpoint. Defaults to the staff-42 Keycloak realm. */
  tokenUrl?: string;
  /** Automatic retry behaviour, same semantics as the v2 client. */
  retry?: RetryConfig;
}

/** Raw token response from the OIDC provider (only the fields we use). */
interface OidcTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms after which the access token should be considered expired */
  accessExpiresAt: number;
  /** epoch ms after which the refresh token should be considered expired */
  refreshExpiresAt: number;
}

class Fast42v3 {
  private _config: Fast42v3Config
  private _tokenUrl: string
  private _retry: Required<RetryConfig>
  private _tokens: TokenSet | undefined
  /** Guards against concurrent (re)authentications firing multiple token requests at once. */
  private _pending: Promise<string> | undefined
  private NOTINITIALIZED = "Fast42v3 is not initialized. Call init() first"

  /**
   * Constructs the Fast42v3 client for the Intra v3 microservices.
   *
   * @param {Fast42v3Config} config OIDC credentials and 42 user credentials. See Fast42v3Config.
   */
  constructor(config: Fast42v3Config) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error("Fast42v3 requires an OIDC clientId and clientSecret")
    }
    if (!config.username || !config.password) {
      throw new Error("Fast42v3 requires a username and password for the v3 (ROPC) grant")
    }
    this._config = config
    this._tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL
    this._retry = resolveRetry(config.retry)
  }

  /*
   *  Public Methods
   */

  /** Authenticates against the OIDC provider so failures surface early. Returns the client. */
  async init(): Promise<Fast42v3> {
    this._tokens = await this.passwordGrant()
    return this
  }

  async get(service: string, version: string, endpoint: string, options?: { [key: string]: string }): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    return this.apiReq(Method.GET, this.buildUrl(service, version, endpoint, options))
  }

  async delete(service: string, version: string, endpoint: string, body?: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    return this.apiReq(Method.DELETE, this.buildUrl(service, version, endpoint), body)
  }

  async post(service: string, version: string, endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    return this.apiReq(Method.POST, this.buildUrl(service, version, endpoint), body)
  }

  async patch(service: string, version: string, endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    return this.apiReq(Method.PATCH, this.buildUrl(service, version, endpoint), body)
  }

  async put(service: string, version: string, endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    return this.apiReq(Method.PUT, this.buildUrl(service, version, endpoint), body)
  }

  /** Fetches a single page. v3 paginates with `page` and `size` query parameters. */
  async getPage(service: string, version: string, endpoint: string, page: string, options?: { [key: string]: string }): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const _options: { [key: string]: string } = { ...(options ?? {}) }
    if (!('size' in _options)) {
      _options['size'] = '100'
    }
    _options['page'] = page
    return this.get(service, version, endpoint, _options)
  }

  /**
   * Fetches all pages of an endpoint. Unlike v2 (which exposes the total in the `x-total` header),
   * v3 returns the total page count in the response body (`pages`). We read that from a clone of the
   * first page so the caller can still consume the original Response, then fan out the rest.
   */
  async getAllPages(service: string, version: string, endpoint: string, options?: { [key: string]: string }, start = 1): Promise<Promise<Response>[]> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    let pageSize = 100
    if (options && ('size' in options)) {
      pageSize = parseInt(options['size']!)
    }
    const firstPage = await this.getPage(service, version, endpoint, start.toString(), { ...options, size: pageSize.toString() })
    const pages: Promise<Response>[] = [Promise.resolve(firstPage)]

    let totalPages = start
    try {
      const meta = await firstPage.clone().json() as { pages?: number }
      if (meta && typeof meta.pages === 'number') {
        totalPages = meta.pages
      }
    } catch {
      // Non-JSON body, an error response, or no pagination metadata: treat as a single page.
    }

    for (let i = start + 1; i <= totalPages; i++) {
      pages.push(this.getPage(service, version, endpoint, i.toString(), { ...options, size: pageSize.toString() }))
    }
    return pages
  }

  /**
   * Forces a token refresh. Call this when the refresh token has expired and the account uses 2FA:
   * pass a fresh TOTP code to re-run the password grant. Without a totp it uses the refresh_token
   * grant if a token set exists, otherwise falls back to a password grant.
   */
  async refreshToken(totp?: string): Promise<void> {
    if (totp !== undefined) {
      this._tokens = await this.passwordGrant(totp)
    } else if (this._tokens) {
      this._tokens = await this.refreshGrant(this._tokens.refreshToken)
    } else {
      this._tokens = await this.passwordGrant()
    }
  }

  /** Clears the cached tokens. Present for symmetry with the v2 client. */
  async disconnect(): Promise<void> {
    this._tokens = undefined
  }

  /*
   *  Private Methods
   */

  private buildUrl(service: string, version: string, endpoint: string, options?: { [key: string]: string }): string {
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
    return `https://${service}.42.fr/api/${version}${path}` + parseOptions(options)
  }

  private async apiReq(method: Method, url: string, body?: any): Promise<Response> {
    // GET requests are idempotent, so it is safe to retry them on 5xx server errors as well. Writes
    // may not be idempotent, so we only retry rate-limit (429) responses for those.
    const retryServerErrors = method === Method.GET
    return runWithRetry(this._retry, retryServerErrors, async () => {
      const accessToken = await this.getValidToken()
      const headers: { [key: string]: string } = {
        'Authorization': `Bearer ${accessToken}`,
      }
      const init: RequestInit = { method, headers }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(url, init)
    }, () => this.invalidateAccessToken())
  }

  /**
   * Marks the cached access token as expired so the next attempt re-authenticates (via the refresh
   * token when it is still valid). Used to recover from a token that was invalidated provider-side
   * before our copy expired.
   */
  private invalidateAccessToken(): void {
    if (this._tokens) {
      this._tokens.accessExpiresAt = 0
    }
  }

  /** Returns a valid access token, refreshing or re-authenticating as needed. */
  private async getValidToken(): Promise<string> {
    if (this._tokens && Date.now() < this._tokens.accessExpiresAt) {
      return this._tokens.accessToken
    }
    // De-duplicate concurrent (re)authentications: only one token request is in flight at a time.
    if (!this._pending) {
      this._pending = this.reauthenticate().finally(() => { this._pending = undefined })
    }
    return this._pending
  }

  private async reauthenticate(): Promise<string> {
    if (this._tokens && Date.now() < this._tokens.refreshExpiresAt) {
      this._tokens = await this.refreshGrant(this._tokens.refreshToken)
    } else {
      this._tokens = await this.passwordGrant()
    }
    return this._tokens.accessToken
  }

  private async passwordGrant(totp?: string): Promise<TokenSet> {
    const body: { [key: string]: string } = {
      grant_type: 'password',
      username: this._config.username,
      password: this._config.password,
    }
    const code = totp ?? this._config.totp
    if (code) {
      body['totp'] = code
    }
    return this.requestToken(body)
  }

  private async refreshGrant(refreshToken: string): Promise<TokenSet> {
    return this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  }

  private async requestToken(body: { [key: string]: string }): Promise<TokenSet> {
    const basic = Buffer.from(`${this._config.clientId}:${this._config.clientSecret}`).toString('base64')
    const response = await fetch(this._tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`,
      },
      body: new URLSearchParams(body).toString(),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Error getting v3 access token: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`)
    }
    const token = await response.json() as OidcTokenResponse
    const now = Date.now()
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: now + Math.max(0, token.expires_in - TOKEN_EXPIRY_BUFFER_S) * 1000,
      refreshExpiresAt: now + Math.max(0, token.refresh_expires_in - TOKEN_EXPIRY_BUFFER_S) * 1000,
    }
  }

  private isInitialized(): boolean {
    if (!this._tokens) {
      console.error("Fast42v3 not initialized, please call .init() first")
      return false
    }
    return true
  }
}

export default Fast42v3
