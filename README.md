# Fast42

Fast TS/JS connector to the 42API, for server-side use.

Features:
- Fast! Gets the most out of your rate-limit, so you don't have to wait forever.
- Automatically determines the rate limit of your API key.
- Queues requests (using bottleneck)
- Multi-key support (be carefull, it might be too fast! 🚀)
- Automatic retries on rate-limit (429) and server (5xx) errors, with back-off.
- Convenience: fetch all pages from an endpoint with a single method call!
- Clustering (v2.1 and up): using Redis you can run multiple instances on the same API keys!

Public Methods:
```ts
constructor(
  secrets: ApiSecret[] // Api Secrets, see type below
  settings?: Fast42Settings
);

interface Fast42Settings {
    concurrentOffset?: number; // default is 0, can be used to slow down the requests. ex: if your key can do 4 req/s you can set this to 1 to only make 3 req/s. Usefull if your backend or db can't keep up.
    jobExpiration?: number; // default is 60000ms, especially important when using redis to kill infinite jobs
    redisConfig?: RedisConfig; // config to connect to redis, see below
    scopes?: string[]; // default is ['public', 'projects']
    retry?: RetryConfig; // automatic retry behaviour, see below
}

interface ApiSecret {
    client_id: string;
    client_secret: string;
}
interface RedisConfig {
    host: string;
    port: number;
    password?: string;
}
interface RetryConfig {
    enabled?: boolean; // master switch, default is true
    maxServerErrorRetries?: number; // max retries on 5xx errors per request, default is 5. 429s are always retried indefinitely.
    serverErrorBackoff?: number; // base ms to wait before retrying a 5xx error, default is 30000
    retryAfterFallback?: number; // seconds to wait on a 429 when no Retry-After header is present, default is 1
    jitter?: number; // max random extra ms added to every retry wait, default is 10000
}

// Always call .init() first after constructing Fast42!
init(): Promise<Fast42>

getPage(url: string, page: string, options?: {
    [key: string]: string;
}): Promise<Response>

getAllPages(url: string, options?: {
    [key: string]: string;
}, start?: number): Promise<Promise<Response>[]>

get(endpoint: string, options?: {
    [key: string]: string;
}): Promise<Response>

delete(endpoint: string): Promise<Response>
post(endpoint: string, body: any): Promise<Response>
patch(endpoint: string, body: any): Promise<Response>
put(endpoint: string, body: any): Promise<Response>

// use a user's accesstoken to make the request, you still need to initialize Fast42 with the same api key used to authenticate the user
postWithUserAccessToken(accessToken: AccessToken, endpoint: string, body: any): Promise<Response>

// used for testing, just runs a random job on the current limiter
doJob(job: any): Promise<unknown>;

// Important when using redis! Closes the connection and stops logging.
disconnect(): Promise<void[]>;
```

### Install
```sh
npm i @codam/fast42
```

Basic usage:

```ts
import Fast42 from "@codam/fast42"

const api = await new Fast42([
  {
    client_id: "<YOUR API CLIENT ID>",
    client_secret: "<YOUR API CLIENT SECRET>",
  }
]).init()

const campus_id = 14;
const pages = await api.getAllPages(`/campus/${campus_id}/users`, {
  'filter[campus_id]': campus_id.toString(), // this makes no sense but it gives an example of using options
})
```

Obviously your id/secret should come from the environment and not be committed to git. (I recommend using a `.env` file and the `dotenv` package)

### Intra v3 API (`Fast42v3`)

The Intra **v3** API is not a versioned path on `api.intra.42.fr` — it is a set of independent microservices, each on its own host with its own internal version:

| Service | Host | Version |
| --- | --- | --- |
| Paced System | `pace-system.42.fr` | `v1` |
| Freezes | `freeze.42.fr` | `v2` |
| Chronos | `chronos.42.fr` | `v1` |
| Alumni Management | `alumni-management.42.fr` | `v1` |

It also authenticates completely differently from v2: instead of the `client_credentials` grant, v3 uses an OIDC (Keycloak) provider with the **Resource Owner Password Credentials** grant — separate OIDC client credentials plus a 42 username/password, and (if the account has 2FA) a one-time TOTP code. Tokens are refreshed automatically via the refresh token. v3 has **no documented rate limits**, so `Fast42v3` has no Bottleneck limiter (429/5xx retries still apply).

Because the two APIs share almost nothing, v3 lives in a **separate client**, `Fast42v3`. Use it alongside `Fast42` (v2) as needed.

```ts
import { Fast42v3 } from "@codam/fast42"

const v3 = await new Fast42v3({
  clientId: process.env['FT_OIDC_UID']!,      // OIDC_RP_CLIENT_ID
  clientSecret: process.env['FT_OIDC_SECRET']!, // OIDC_RP_CLIENT_SECRET
  username: process.env['FT_USERNAME']!,
  password: process.env['FT_PASSWORD']!,
  // totp: "123456",   // only if the account has 2FA enabled
}).init()

// Every call takes the service subdomain and its version explicitly:
const milestones = await v3.get('pace-system', 'v1', '/milestones')
const attendances = await v3.get('chronos', 'v1', '/attendances', { campus_id: '14' })

// Pagination uses `page` + `size` (v3 returns the total page count in the body):
const pages = await v3.getAllPages('pace-system', 'v1', '/milestones')
```

`Fast42v3` config:

```ts
interface Fast42v3Config {
  clientId: string;      // OIDC_RP_CLIENT_ID
  clientSecret: string;  // OIDC_RP_CLIENT_SECRET
  username: string;      // 42 username (for the ROPC grant)
  password: string;      // 42 password (for the ROPC grant)
  totp?: string;         // one-time code, only if 2FA is enabled (consumed by the initial grant)
  tokenUrl?: string;     // defaults to https://auth.42.fr/auth/realms/staff-42/protocol/openid-connect/token
  retry?: RetryConfig;   // same retry semantics as the v2 client
}
```

Public methods:

```ts
init(): Promise<Fast42v3> // authenticate; call before anything else

get(service: string, version: string, endpoint: string, options?: { [key: string]: string }): Promise<Response>
post(service: string, version: string, endpoint: string, body: any): Promise<Response>
patch(service: string, version: string, endpoint: string, body: any): Promise<Response>
put(service: string, version: string, endpoint: string, body: any): Promise<Response>
delete(service: string, version: string, endpoint: string, body?: any): Promise<Response>

getPage(service: string, version: string, endpoint: string, page: string, options?: { [key: string]: string }): Promise<Response>
getAllPages(service: string, version: string, endpoint: string, options?: { [key: string]: string }, start?: number): Promise<Promise<Response>[]>

// Force a token refresh. If the refresh token has expired on a 2FA account, pass a fresh TOTP:
refreshToken(totp?: string): Promise<void>

disconnect(): Promise<void> // clears cached tokens
```

> **Note:** v3's password + TOTP grant is inherently interactive. It is only unattended-friendly when the service account has 2FA disabled (username/password only, with automatic refresh). With 2FA enabled you must supply a fresh TOTP via `refreshToken(totp)` whenever the refresh token expires.

### Retries

The rate limiter does its best to stay under your key's limits, but the 42 API counts requests on its own clock, so an occasional `429 Too Many Requests` can still slip through (especially when running multiple instances). Fast42 therefore retries automatically:

- **429 (rate limit):** retried indefinitely, waiting for the duration of the `Retry-After` header (or `retryAfterFallback` seconds when it is absent). Applies to every request, including writes — a 429 is rejected before processing, so it is always safe to retry.
- **5xx (server error):** retried up to `maxServerErrorRetries` times (default 5), waiting `serverErrorBackoff` ms between attempts. Only `GET` requests are retried on 5xx, since writes (`post`/`put`/`patch`/`delete`) may not be idempotent. After the retries are exhausted the last `Response` is returned, so existing `.ok`/`.status` checks keep working.
- **401 (unauthorized):** the cached access token is dropped and the request is retried **once** after re-authenticating. This covers the tail end of a token's life, which cannot be avoided by refreshing earlier (see [tokens](#tokens)). The retry is deliberately capped at one, so a genuinely revoked or unauthorized key still returns its 401 to you instead of looping.

Every retry goes back through the rate limiter, and a random `jitter` (up to 10s by default) is added to each wait to spread retries out. Retries can be tuned or disabled via the `retry` setting:

```ts
const api = await new Fast42([{ client_id, client_secret }], {
  retry: {
    enabled: true,            // set to false to get the raw Response back without retrying
    maxServerErrorRetries: 3,
    serverErrorBackoff: 30000,
    retryAfterFallback: 1,
    jitter: 10000,
  },
}).init();
```

This means your own code generally no longer needs a 429/5xx retry loop around `get`/`getAllPages`.

How I use it:

```ts
import Fast42, { Response } from "@codam/fast42"
import dotenv from "dotenv";

// utility function for error handling and logging
function getPageNumberFromUrl(url: string): string | undefined {
  const match = url.match(/page\[number\]=(\d+)/);
  if (match && match[1]) {
    return match[1];
  }
  return undefined;
}

// utility function for logging errors
function printHeaders(headers: any, print: (arg0: string) => void) {
  headers.forEach((v: string, k: string) => {
    print(`${k}: ${v}`)
  })
}

async function getAll42(
  api: Fast42,
  url: string,
  options: { [key: string]: string },
  callback: (_: Response) => any,
) {
  const pages: Promise<Promise<Response>[]> = await api.getAllPages(url, options);

  console.log(`Retrieving ${pages.length} pages for ${url}`);

  // Attach a callback function to be called when the page promise resolves
  return Promise.all(pages.map(async (page) => {
    const p = await page;
    const pagenr = getPageNumberFromUrl(p.url);
    // No manual 429 retry needed: Fast42 retries rate-limited (429) requests
    // automatically, so any page we get here has already passed the rate limiter.
    // (This used to be required because the timing on the 42api side differs from
    // the timing of the Fast42 ratelimiter.)
    if (p.ok) {
      console.log(`Recieved ${url} page: ${pagenr}`);
      return callback(p);
    } else {
      printHeaders(p.headers, console.log);
      console.error(`Failed to get ${url} page (${p.status}): ${pagenr}`);
    }
  }));
}

async function getAll42Cursus(api: Fast42) {
  return getAll42(api, "/cursus", {}, async (page) => {
    (await page.json() as any).forEach(async (c: any) => {
      // Insert `c` into DB
    })
  }).then(async () => {
    console.log(`Total: ${/* Cursus count from db*/} Cursi`)
  })
}

// Using 2 keys here, but with 8 req/s per key it will might be a bit too fast ;)
async function main() {
  const api = await new Fast42([
    {
      client_id: process.env['FTAPI_UID'],
      client_secret: process.env['FTAPI_SECRET'],
    },
    {
      client_id: process.env['FTAPI_UID1'],
      client_secret: process.env['FTAPI_SECRET1'],
    }
  ], { concurrentOffset: 1 }).init()
  await getAll42Cursus(api);
}
```

### Tokens

Worth knowing, because it is not what the OAuth spec would lead you to expect: **42 issues one access token per application and returns that same token for every `client_credentials` grant until it genuinely expires.** `expires_in` counts down as the token ages (ask again 100 seconds later and you get the identical token string with `expires_in` 100 lower), while `created_at` stays fixed at the original creation time.

Two consequences:

- `expires_in` is the **remaining** lifetime as of that response, not a lifetime measured from `created_at`. Subtracting the token's age from it double-counts.
- **You cannot refresh early.** Re-authenticating before expiry just hands back the same token, so a token's final seconds are unavoidable. That is what the automatic 401 retry is for: when the token does lapse, the next request drops it, re-authenticates, and retries once.

Because the token is app-wide, there is no per-app token cap and no eviction — extra grants do not invalidate anyone else's token, so running many instances on one key is safe from an auth standpoint. Redis shares bottleneck's **rate-limit counters** between instances; tokens are deliberately not shared, since each instance simply receives the same app-wide token anyway. Within an instance, concurrent requests that all find an expired token share a single token request rather than each firing their own.

Usage with redis:
```ts
    const api = await (new Fast42([
      {
        client_id: process.env['FTAPI_UID'],
        client_secret: process.env['FTAPI_SECRET'],
      },
    ], {
      concurrentOffset: 0,
      jobExpiration: 20000, // setting an expiration on all jobs is important when clustering!
      redisConfig: {
        host: "127.0.0.1",
        port: 6379,
        password: "somepassword"
      },
      scopes: ["public", "projects"],
    }).init());
    const job = await api.get("/projects/1");    
    const item = await job.json();

    await api.disconnect();
```
