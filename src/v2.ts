import Bottleneck from "@sergiiivzhenko/bottleneck";
import NodeCache from 'node-cache';
import redis from 'redis';
import { Method, RetryConfig, TOKEN_EXPIRY_BUFFER_S, parseOptions, resolveRetry, runWithRetry } from './shared.js';

interface AccessTokenInfo {
  access_token: AccessToken
  token_type: string
  expires_in: number
  scope: string
  created_at: number
}

type AccessToken = string

interface RateLimit {
  id: number,
  hourly_limit: number,
  hourly_remaining: number,
  secondly_limit: number,
  secondly_remaining: number,
}

interface ApiSecret {
  client_id: string,
  client_secret: string,
}

interface LimiterPair {
  appId: number,
  limiter: Bottleneck,
  secret: ApiSecret,
  tokenIndex: number,
  jobOptions: Bottleneck.JobOptions
}


interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

interface Fast42Settings {
  concurrentOffset?: number;
  jobExpiration?: number;
  redisConfig?: RedisConfig;
  scopes?: string[];
  retry?: RetryConfig;
}

class Fast42 {
  private _secrets: ApiSecret[]
  private _limiterPairs: LimiterPair[]
  private _rootUrl: string
  private _cache: NodeCache
  private _keyCount: number
  private _currentIndex: number
  private _concurrentOffset: number
  private NOTINITIALIZED = "Fast42 is not initialized. Call init() first"
  /** Guards against concurrent (re)authentications firing multiple token requests per key at once. */
  private _pendingTokens: Map<number, Promise<AccessTokenInfo>>
  private _redisConfig: RedisConfig | undefined;
  private _jobExpiration: number;
  private _scopes: string[];
  private _retry: Required<RetryConfig>;

  /**
   * Constructs the api42 class
   *
   * @param {ApiSecret[]} secrets Array of ApiSecret objects containing the client_id and client_secret
   *  make sure all keys have the same rate limit. Since the keys are rotated after every call, they are used equally.
   * @param {number} concurrentOffset Offset from the maximum concurrent requests per second, to make sure the rate limit is not exceeded.
   *  The default value is 0, which means that the maximum concurrent requests per second is used (but you might get more retries).
   *  Recommended value is 1 if your key can do more than 2 req per second.
   * @param {RedisConfig} redisConfig Optional Redis configuration object. If provided, bottleneck will use Redis to store the rate limit counters.
   * This is useful if you want to run multiple instances of your application, and want to share the rate limit counters between them.
   *
   */
  constructor(secrets: ApiSecret[], settings?: Fast42Settings)
  constructor(secrets: ApiSecret[], concurrentOffset?: number, jobExpiration?: number, redisConfig?: RedisConfig)
  constructor(
    secrets: ApiSecret[],
    settingsOrConcurrentOffset: Fast42Settings | number = 0,
    jobExpiration: number = 60000,
    redisConfig?: RedisConfig,
  ) {
    if (secrets.length === 0) {
      throw new Error("Fast42 requires at least one 42 Api Key/Secret pair")
    }
    const settings: Fast42Settings = typeof settingsOrConcurrentOffset === 'object'
      ? settingsOrConcurrentOffset
      : {
        concurrentOffset: settingsOrConcurrentOffset,
        jobExpiration,
        redisConfig,
      }
    this._secrets = secrets
    this._rootUrl = "https://api.intra.42.fr/v2"
    this._cache = new NodeCache()
    this._limiterPairs = []
    this._keyCount = secrets.length
    this._currentIndex = 0
    this._concurrentOffset = settings.concurrentOffset ?? 0
    this._pendingTokens = new Map()
    this._redisConfig = settings.redisConfig
    this._jobExpiration = settings.jobExpiration ?? 60000
    this._scopes = settings.scopes ?? ['public', 'projects']
    this._retry = resolveRetry(settings.retry)
  }

  /*
   *  Public Methods
   */

  async init(): Promise<Fast42> {
    for (let index = 0; index < this._keyCount; index++) {
      const secret: ApiSecret = this._secrets[index]!
      const accessToken = await this.getAccessToken(secret.client_id, secret.client_secret)
      this.storeToken(accessToken, index)
      const limit = await this.getRateLimits((await this.retrieveToken(index)).access_token)
      let limiter: Bottleneck | undefined;

      if (this._redisConfig) {
        limiter = this.createRedisLimiter(limit, this._concurrentOffset, this._redisConfig)
      } else {
        limiter = this.createLimiter(limit, this._concurrentOffset)
      }

      this._limiterPairs.push({
        appId: limit.id,
        limiter,
        secret,
        tokenIndex: index,
        jobOptions: {
          expiration: this._jobExpiration,
        }
      })
    }
    console.log(`Limiters length: ${this._limiterPairs.length}`)
    // Schedule a job per limiter to compensate the limiter for the request made earlier to get the rate limits
    for (let i = 0; i < this._limiterPairs.length; i++) {
      this._limiterPairs[i]!.limiter.schedule(this._limiterPairs[i]!.jobOptions,
        (): any => { return Promise.resolve("limiter initialized") })
    }
    return this
  }

  async getPage(url: string, page: string, options?: { [key: string]: string }): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    let _options: { [key: string]: string } = {};
    if (options) {
      _options = options;
    }
    if (!('page[size]' in _options)) {
      _options['page[size]'] = '100'
    }
    _options['page[number]'] = page
    return this.get(url, _options)
  }

  async getAllPages(url: string, options?: { [key: string]: string }, start = 1): Promise<Promise<Response>[]> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    let pageSize = 100
    if (options && ('page[size]' in options)) {
      pageSize = parseInt(options['page[size]']!)
    }
    const _options: { [key: string]: string } = {
      ...options,
      'page[number]': start.toString(),
      'page[size]': pageSize.toString(),
    }
    const firstPage = await this.get(url, _options)
    const pages: Promise<Response>[] = [Promise.resolve(firstPage)]
    if (firstPage.headers.get("x-total") !== null) {
      const totalItems = parseInt(firstPage.headers.get("x-total")!)
      const totalPages = Math.ceil(totalItems / pageSize)
      for (let i = start + 1; i <= totalPages; i++) {
        const _options: { [key: string]: string } = {
          ...options,
          'page[number]': i.toString(),
          'page[size]': pageSize.toString(),
        }
        const page = this.get(url, _options)
        pages.push(page)
      }
    }
    return pages
  }

  async get(endpoint: string, options?: { [key: string]: string }): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const url = this._rootUrl + endpoint + parseOptions(options)
    const response = this.apiReq(Method.GET, this._limiterPairs[index]!, url)
    return response
  }

  async delete(endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const url = this._rootUrl + endpoint
    const response = this.apiReqWithBody(Method.DELETE, this._limiterPairs[index]!, url, body)
    return response
  }

  async post(endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const url = this._rootUrl + endpoint
    const response = this.apiReqWithBody(Method.POST, this._limiterPairs[index]!, url, body)
    return response
  }

  async patch(endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const url = this._rootUrl + endpoint
    const response = this.apiReqWithBody(Method.PATCH, this._limiterPairs[index]!, url, body)
    return response
  }

  async put(endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const url = this._rootUrl + endpoint
    const response = this.apiReqWithBody(Method.PUT, this._limiterPairs[index]!, url, body)
    return response
  }

  async postWithUserAccessToken(accessToken: AccessToken, endpoint: string, body: any): Promise<Response> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const limit = await this.getRateLimits(accessToken)
    const limiterPair = this._limiterPairs.find((limiterPair) => limiterPair.appId === limit.id)
    if (limiterPair === undefined) {
      throw new Error("AppId not found, you need to initialize fast42 with the API keys used to get the user accessToken")
    }
    const url = this._rootUrl + endpoint
    // The user's token is handed to the request directly instead of going through the token cache:
    // it belongs to the caller, so it cannot be re-minted from our client credentials, and caching it
    // under a shared key meant two concurrent calls could overwrite each other and send a request
    // signed with the wrong user's token.
    const response = this.apiReqWithBody(Method.POST, limiterPair, url, body, accessToken)
    return response
  }

  public async doJob(job: any): Promise<unknown> {
    if (!this.isInitialized()) {
      return Promise.reject(new Error(this.NOTINITIALIZED))
    }
    const index = this.getCurrentIndexAndSetNext()
    const limiterPair = this._limiterPairs[index]!;
    const response = limiterPair.limiter.schedule(
      limiterPair.jobOptions, job);
    return response;
  }

  public async disconnect() {
    return Promise.all(this._limiterPairs.map(async (limiterPair) => {
      return limiterPair.limiter.disconnect(true)
    }))
  }

  /*
   *  Private Methods
   */


  private async apiReq(method: Method.GET, limiterPair: LimiterPair, url: string): Promise<Response> {
    // GET requests are idempotent, so it is safe to retry them on server errors as well.
    return this.scheduleWithRetry(limiterPair, true, async () => {
      const accessToken = await this.retrieveToken(limiterPair.tokenIndex)
      return fetch(url, {
        method: method,
        headers: {
          Authorization: `Bearer ${accessToken.access_token}`
        }
      })
    }, () => this.invalidateToken(limiterPair.tokenIndex))
  }

  /**
   * When `accessToken` is given it is used verbatim instead of this client's cached token (see
   * postWithUserAccessToken), and a 401 is not retried: the token belongs to the caller and cannot
   * be re-minted from our client credentials.
   */
  private async apiReqWithBody(method: Method.PATCH | Method.POST | Method.PUT | Method.DELETE, limiterPair: LimiterPair, url: string, body: any, accessToken?: AccessToken): Promise<Response> {
    // Writes may not be idempotent, so we only retry rate-limit (429) responses (which are
    // rejected before processing and therefore safe to retry), not 5xx server errors.
    return this.scheduleWithRetry(limiterPair, false, async () => {
      const token = accessToken ?? (await this.retrieveToken(limiterPair.tokenIndex)).access_token
      return fetch(url, {
        method: method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    }, accessToken === undefined ? () => this.invalidateToken(limiterPair.tokenIndex) : undefined)
  }

  /**
   * Schedules a request on the given limiter and transparently retries it on rate-limit (429),
   * unauthorized (401) and, optionally, server-error (5xx) responses. Each (re)try goes through the
   * limiter again, so the rate limiter keeps accounting for retried requests, and re-reads the token,
   * so a retry after `onUnauthorized` picks up a freshly minted one. The retry policy itself lives in
   * the shared runWithRetry helper.
   */
  private async scheduleWithRetry(limiterPair: LimiterPair, retryServerErrors: boolean, job: () => Promise<Response>, onUnauthorized?: () => void): Promise<Response> {
    return runWithRetry(this._retry, retryServerErrors, () =>
      limiterPair.limiter.schedule(limiterPair.jobOptions, job), onUnauthorized)
  }

  private async getAccessToken(clientid: string, clientsecret: string): Promise<AccessTokenInfo> {
    const response = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&client_id=${clientid}&client_secret=${clientsecret}&scope=${this._scopes.join('%20')}`
    })
    if (!response.ok) {
      throw new Error(`Error getting access token: ${response.status} ${response.statusText}`)
    }
    const accessToken = await response.json() as AccessTokenInfo
    return accessToken
  }

  private storeToken(accessToken: AccessTokenInfo, index: number): void {
    this._cache.set(`accessToken-${index}`, accessToken, this.tokenTtl(accessToken))
  }

  /**
   * Seconds a token may stay cached.
   *
   * 42 issues a single token per application and keeps returning that same token for every
   * client_credentials grant until it actually expires, with `expires_in` counting down: asking again
   * 100 seconds later returns the identical token string with `expires_in` 100 lower. `expires_in` is
   * therefore the remaining lifetime as of this response, and `created_at` (the original creation
   * time, which stays fixed across grants) must not be subtracted from it again.
   *
   * The result is clamped to at least one second, which is what keeps a nearly-dead token from being
   * cached forever: `expires_in - 20` lands on exactly 0 for a token with 20 seconds left, and
   * node-cache reads a TTL of 0 as "never expires". Because re-authenticating early just returns the
   * same token, the final seconds of a token's life cannot be avoided by refreshing sooner; they are
   * covered by the 401 retry instead.
   */
  private tokenTtl(accessToken: AccessTokenInfo): number {
    return Math.max(1, accessToken.expires_in - TOKEN_EXPIRY_BUFFER_S)
  }

  /** Drops the cached token for a key, so the next request authenticates again. */
  private invalidateToken(index: number): void {
    this._cache.del(`accessToken-${index}`)
  }

  private async retrieveToken(index: number): Promise<AccessTokenInfo> {
    const accessToken: AccessTokenInfo | undefined = this._cache.get(`accessToken-${index}`)
    if (accessToken) {
      return accessToken
    }
    return this.refreshToken(index)
  }

  /**
   * Mints a new token for a key. Every queued request calls retrieveToken independently, so without
   * de-duplication a single expiry would fire one client_credentials grant per in-flight request
   * (maxConcurrent of them at once). Concurrent callers share one token request instead.
   */
  private async refreshToken(index: number): Promise<AccessTokenInfo> {
    const pending = this._pendingTokens.get(index)
    if (pending) {
      return pending
    }
    const secret = this._secrets[index]
    if (!secret) {
      return Promise.reject(new Error(`ApiSecret not found at index: ${index}`))
    }
    const request = this.getAccessToken(secret.client_id, secret.client_secret)
      .then((newToken) => {
        this.storeToken(newToken, index)
        return newToken
      })
      .finally(() => {
        this._pendingTokens.delete(index)
      })
    this._pendingTokens.set(index, request)
    return request
  }

  private getCurrentIndexAndSetNext(): number {
    const key = this._currentIndex
    if (this._currentIndex === this._keyCount - 1) {
      this._currentIndex = 0
    } else {
      this._currentIndex += 1
    }
    return key
  }

  private async getRateLimits(accessToken: AccessToken): Promise<RateLimit> {
    const response = await fetch("https://api.intra.42.fr/v2/cursus", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    })
    if (response.ok) {
      const rateLimits: RateLimit = {
        id: parseInt(response.headers.get("x-application-id")!),
        hourly_limit: parseInt(response.headers.get("x-hourly-ratelimit-limit")!),
        hourly_remaining: parseInt(response.headers.get("x-hourly-ratelimit-remaining")!),
        secondly_limit: parseInt(response.headers.get("x-secondly-ratelimit-limit")!),
        secondly_remaining: parseInt(response.headers.get("x-secondly-ratelimit-remaining")!),
      }
      return rateLimits
    }
    return Promise.reject(`Error getting rate limits: ${response.status} ${response.statusText}`)
  }

  private createLimiter(limit: RateLimit, concurrentOffset: number): Bottleneck {
    const limiter = new Bottleneck({
      // Hourly rate limit
      reservoir: limit.hourly_remaining,
      reservoirRefreshAmount: limit.hourly_limit,
      reservoirRefreshInterval: 1000 * 60 * 60,

      // Secondly rate limit
      maxConcurrent: limit.secondly_limit - concurrentOffset,
      minTime: Math.trunc(1000 / limit.secondly_limit) + 25 // arbitrary slowdown to prevent retries,
    });

    limiter.on("error", (err) => {
      console.error(err)
    });
    return limiter
  }

  private createRedisLimiter(limit: RateLimit, concurrentOffset: number, redisConfig: RedisConfig): Bottleneck {
    const limiter = new Bottleneck({
      // Redis options
      id: 'fast42',
      datastore: 'redis',
      clearDatastore: false,
      clientOptions: {
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
      },
      Redis: redis,

      // Hourly rate limit
      reservoir: limit.hourly_remaining,
      reservoirRefreshAmount: limit.hourly_limit,
      reservoirRefreshInterval: 1000 * 60 * 60,

      // Secondly rate limit
      maxConcurrent: limit.secondly_limit - concurrentOffset,
      minTime: Math.trunc(1000 / limit.secondly_limit) + 25 // arbitrary slowdown to prevent retries,
    });

    limiter.on("error", (err) => {
      console.error(err)
    });

    return limiter;
  }

  private isInitialized(): boolean {
    if (!this._limiterPairs || this._limiterPairs.length <= 0) {
      console.error("Fast42 not initialized, please call .init() first")
      return false
    }
    return true
  }
}

export default Fast42
