import Bottleneck from "bottleneck";
import fetch, { Response } from 'node-fetch';
import NodeCache from 'node-cache';
import { createClient } from "redis";

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

enum Method {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
  PATCH = 'PATCH',
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
  private _redisConfig: RedisConfig | undefined;
  private _jobExpiration: number;

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
  constructor(secrets: ApiSecret[], concurrentOffset: number = 0, jobExpiration: number = 20000, redisConfig?: RedisConfig) {
    if (secrets.length === 0) {
      throw new Error("Fast42 requires at least one 42 Api Key/Secret pair")
    }
    this._secrets = secrets
    this._rootUrl = "https://api.intra.42.fr/v2"
    this._cache = new NodeCache()
    this._limiterPairs = []
    this._keyCount = secrets.length
    this._currentIndex = 0
    this._concurrentOffset = concurrentOffset
    this._redisConfig = redisConfig
    this._jobExpiration = jobExpiration
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
    const url = this._rootUrl + endpoint + this.parseOptions(options)
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
    const limiter = this._limiterPairs.find((limiterPair) => limiterPair.appId === limit.id)
    if (limiter === undefined) {
      throw new Error("AppId not found, you need to initialize fast42 with the API keys used to get the user accessToken")
    }
    const limiterWithUserToken = {
      ...limiter,
      tokenIndex: -42,
    }
    await this.storeToken({ access_token: accessToken, expires_in: 42 }, -42)
    const url = this._rootUrl + endpoint
    const response = this.apiReqWithBody(Method.POST, limiterWithUserToken, url, body)
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
      return limiterPair.limiter.disconnect()
    }))
  }

  /*
   *  Private Methods 
   */


  private async apiReq(method: Method.GET, limiterPair: LimiterPair, url: string): Promise<Response> {
    const accessToken = await this.retrieveToken(limiterPair.tokenIndex)
    const response = limiterPair.limiter.schedule(
      limiterPair.jobOptions,
      (accessToken, url) => {
        return fetch(url, {
          method: method,
          headers: {
            Authorization: `Bearer ${accessToken.access_token}`
          }
        })
      }, accessToken, url)
    return response
  }

  private async apiReqWithBody(method: Method.PATCH | Method.POST | Method.PUT | Method.DELETE, limiterPair: LimiterPair, url: string, body: any): Promise<Response> {
    const accessToken = await this.retrieveToken(limiterPair.tokenIndex)
    const response = limiterPair.limiter.schedule(
      limiterPair.jobOptions,
      (accessToken, url, body) => {
        return fetch(url, {
          method: method,
          headers: {
            'Authorization': `Bearer ${accessToken.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      }, accessToken, url, body)
    return response
  }

  private parseOptions(options: { [key: string]: string } | undefined): string {
    let optionsString = ""
    if (!options) {
      return optionsString
    }
    let firstOption = true
    for (let [key, value] of Object.entries(options)) {
      if (firstOption) {
        optionsString += `?${key}=${value}`
        firstOption = false
      } else {
        optionsString += `&${key}=${value}`
      }
    }
    return optionsString
  }

  private async getAccessToken(clientid: string, clientsecret: string): Promise<AccessTokenInfo> {
    const response = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&client_id=${clientid}&client_secret=${clientsecret}&scope=projects%20public`
    })
    if (!response.ok) {
      throw new Error(`Error getting access token: ${response.status} ${response.statusText}`)
    }
    const accessToken = await response.json() as AccessTokenInfo
    return accessToken
  }

  private storeToken(accessToken: { access_token: AccessToken, expires_in: number }, index: number): void {
    this._cache.set(`accessToken-${index}`, accessToken, accessToken.expires_in - 20) // refetch the token 20 seconds before expiration
  }

  private async retrieveToken(index: number): Promise<AccessTokenInfo> {
    const accessToken: AccessTokenInfo | undefined = this._cache.get(`accessToken-${index}`)
    if (accessToken) {
      return accessToken
    }
    if (this._secrets[index]) {
      const newToken = await this.getAccessToken(this._secrets[index]!.client_id, this._secrets[index]!.client_secret)
      this.storeToken(newToken, index)
      return newToken
    }
    return Promise.reject(`ApiSecret not found at index: ${index}`)
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
    // Create a redis client
    const client = createClient(redisConfig.port, redisConfig.host, {
      password: redisConfig.password,
    });

    client.on('error', function (err) {
      console.log('Redis client encountered an error: ', err);
    });

    const limiter = new Bottleneck({
      // Redis options
      id: 'fast42',
      datastore: 'redis',
      clearDatastore: false,
      client: client,

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

export { Response } from "node-fetch"

export default Fast42
