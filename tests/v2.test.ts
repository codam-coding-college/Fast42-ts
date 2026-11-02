import Fast42 from '../src/v2';

const client_id = "test";
const client_secret = "test";
const mockedFetch = jest.fn();
const originalFetch = globalThis.fetch;

beforeAll(() => {
    globalThis.fetch = mockedFetch as unknown as typeof fetch;
});

afterAll(() => {
    globalThis.fetch = originalFetch;
});

beforeEach(() => {
    mockedFetch.mockReset();
});

it("Should instantiate", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ]);
    expect(api).toBeInstanceOf(Fast42);
})

it("Should instantiate using Redis", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ], 0, 2000, {
        host: "localhost",
        port: 6379,
        password: undefined,
    });
    expect(api).toBeInstanceOf(Fast42);
})

it("Should instantiate with settings object and scopes", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ], {
        concurrentOffset: 0,
        jobExpiration: 2000,
        scopes: ['public', 'projects', 'profile'],
    });
    expect(api).toBeInstanceOf(Fast42);
})

it("Should default scopes to public and projects", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ]);
    expect((api as any)._scopes).toEqual(['public', 'projects']);
})

it("Should use configured scopes when requesting access token", async () => {
    mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
            access_token: 'token',
            token_type: 'bearer',
            expires_in: 7200,
            scope: 'public projects profile',
            created_at: 0
        })
    } as any);
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ], {
        scopes: ['public', 'projects', 'profile'],
    });
    await (api as any).getAccessToken('id', 'secret');
    expect(mockedFetch).toHaveBeenCalledWith(
        "https://api.intra.42.fr/oauth/token",
        expect.objectContaining({
            body: expect.stringContaining("scope=public%20projects%20profile")
        })
    );
})

describe("scheduleWithRetry", () => {
    // A fake limiter that just runs the scheduled job immediately, so we can test the
    // retry logic without spinning up a real Bottleneck instance or hitting the network.
    const fakeLimiterPair = (job: () => Promise<any>) => ({
        appId: 1,
        limiter: { schedule: (_opts: any, fn: () => Promise<any>) => fn() },
        secret: { client_id, client_secret },
        tokenIndex: 0,
        jobOptions: {},
        _job: job,
    });

    // Minimal stand-in for a node-fetch Response.
    const res = (status: number, retryAfter?: string) => ({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    });

    // No real waiting between retries.
    const noWaitRetry = { serverErrorBackoff: 0, retryAfterFallback: 0, jitter: 0, maxServerErrorRetries: 2 };

    const newApi = (retry: any = noWaitRetry) =>
        new Fast42([{ client_id, client_secret }], { retry });

    it("retries a 429 until it succeeds, respecting Retry-After", async () => {
        const responses = [res(429, '0'), res(429, '0'), res(200)];
        const job = jest.fn(async () => responses.shift());
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(200);
        expect(job).toHaveBeenCalledTimes(3);
    });

    it("retries 5xx errors up to maxServerErrorRetries then returns the last response", async () => {
        const job = jest.fn(async () => res(503));
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(503);
        expect(job).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it("does not retry 5xx errors when retryServerErrors is false (e.g. writes)", async () => {
        const job = jest.fn(async () => res(503));
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, false, job);

        expect(result.status).toBe(503);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("still retries 429 for writes (retryServerErrors false)", async () => {
        const responses = [res(429, '0'), res(201)];
        const job = jest.fn(async () => responses.shift());
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, false, job);

        expect(result.status).toBe(201);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it("does not retry when retries are disabled", async () => {
        const job = jest.fn(async () => res(429, '0'));
        const pair = fakeLimiterPair(job);

        const result = await (newApi({ enabled: false }) as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(429);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("returns 2xx responses immediately without retrying", async () => {
        const job = jest.fn(async () => res(200));
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(200);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("returns non-retryable 4xx responses immediately", async () => {
        const job = jest.fn(async () => res(404));
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(404);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("re-authenticates once on a 401 and retries the request", async () => {
        const responses = [res(401), res(200)];
        const job = jest.fn(async () => responses.shift());
        const pair = fakeLimiterPair(job);
        const onUnauthorized = jest.fn();

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job, onUnauthorized);

        expect(result.status).toBe(200);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it("gives up after one re-auth so a revoked key still surfaces its 401", async () => {
        const job = jest.fn(async () => res(401));
        const pair = fakeLimiterPair(job);
        const onUnauthorized = jest.fn();

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job, onUnauthorized);

        expect(result.status).toBe(401);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it("returns the 401 when re-authentication itself fails", async () => {
        const job = jest.fn(async () => res(401));
        const pair = fakeLimiterPair(job);
        const onUnauthorized = jest.fn(async () => { throw new Error("token endpoint down") });

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job, onUnauthorized);

        expect(result.status).toBe(401);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("does not re-authenticate on a 401 without an onUnauthorized handler", async () => {
        const job = jest.fn(async () => res(401));
        const pair = fakeLimiterPair(job);

        const result = await (newApi() as any).scheduleWithRetry(pair, true, job);

        expect(result.status).toBe(401);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("does not re-authenticate on a 401 when retries are disabled", async () => {
        const job = jest.fn(async () => res(401));
        const pair = fakeLimiterPair(job);
        const onUnauthorized = jest.fn();

        const result = await (newApi({ enabled: false }) as any).scheduleWithRetry(pair, true, job, onUnauthorized);

        expect(result.status).toBe(401);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(job).toHaveBeenCalledTimes(1);
    });
});

describe("token caching", () => {
    const nowS = () => Math.floor(Date.now() / 1000);
    const token = (overrides: any = {}) => ({
        access_token: 'tok',
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'public projects',
        created_at: nowS(),
        ...overrides,
    });
    const newApi = () => new Fast42([{ client_id, client_secret }]);

    it("caches a fresh token for expires_in minus the safety buffer", () => {
        expect((newApi() as any).tokenTtl(token())).toBe(7180);
    });

    it("treats expires_in as the remaining lifetime, not a lifetime from created_at", () => {
        // 42 returns the same app-wide token for every grant, counting expires_in down as it ages.
        // The elapsed time is already baked into expires_in and must not be subtracted twice.
        expect((newApi() as any).tokenTtl(token({ expires_in: 200, created_at: nowS() - 7000 }))).toBe(180);
    });

    it("never returns a TTL of 0, which node-cache would read as 'never expires'", () => {
        // Regression: expires_in - 20 lands on exactly 0 for a token with 20 seconds left, which
        // pinned a nearly-dead token in the cache forever and made every later request 401.
        expect((newApi() as any).tokenTtl(token({ expires_in: 20 }))).toBe(1);
        expect((newApi() as any).tokenTtl(token({ expires_in: 5 }))).toBe(1);
        expect((newApi() as any).tokenTtl(token({ expires_in: 0 }))).toBe(1);
    });

    it("stores a nearly-expired token with a finite TTL", () => {
        const api = newApi();
        (api as any).storeToken(token({ expires_in: 20 }), 0);
        // node-cache getTtl returns 0 for a key that never expires, and a timestamp otherwise.
        expect((api as any)._cache.getTtl('accessToken-0')).toBeGreaterThan(0);
    });

    it("de-duplicates concurrent token refreshes for the same key", async () => {
        mockedFetch.mockResolvedValue({ ok: true, json: async () => token() } as any);
        const api = newApi();

        const tokens = await Promise.all(
            Array.from({ length: 5 }, () => (api as any).retrieveToken(0)));

        expect(mockedFetch).toHaveBeenCalledTimes(1);
        tokens.forEach((t: any) => expect(t.access_token).toBe('tok'));
        // A later call is served from the cache, and the in-flight entry is cleaned up.
        await (api as any).retrieveToken(0);
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect((api as any)._pendingTokens.size).toBe(0);
    });

    it("clears the in-flight entry when the token request fails", async () => {
        mockedFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' } as any);
        const api = newApi();

        await expect((api as any).retrieveToken(0)).rejects.toThrow(/Error getting access token: 401/);
        expect((api as any)._pendingTokens.size).toBe(0);
    });

    it("rejects with an Error when no secret exists at the index", async () => {
        await expect((newApi() as any).retrieveToken(9)).rejects.toThrow(/ApiSecret not found at index: 9/);
    });

    it("re-mints the token after invalidateToken drops it", async () => {
        mockedFetch.mockResolvedValue({ ok: true, json: async () => token() } as any);
        const api = newApi();

        await (api as any).retrieveToken(0);
        (api as any).invalidateToken(0);
        await (api as any).retrieveToken(0);

        expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
});

describe("re-authentication on 401", () => {
    const token = (access_token: string) => ({
        access_token, token_type: 'bearer', expires_in: 7200, scope: 'public projects',
        created_at: Math.floor(Date.now() / 1000),
    });
    const res = (status: number) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null } });
    const newApi = () => {
        const api = new Fast42([{ client_id, client_secret }], { retry: { jitter: 0 } });
        (api as any)._limiterPairs = [{
            appId: 1,
            limiter: { schedule: (_opts: any, fn: () => Promise<any>) => fn() },
            secret: { client_id, client_secret },
            tokenIndex: 0,
            jobOptions: {},
        }];
        (api as any).storeToken(token('stale-tok'), 0);
        return api;
    };

    it("mints a new token and retries the GET with it", async () => {
        mockedFetch
            .mockResolvedValueOnce(res(401) as any)
            .mockResolvedValueOnce({ ok: true, json: async () => token('fresh-tok') } as any)
            .mockResolvedValueOnce(res(200) as any);

        const result = await newApi().get("/me");

        expect(result.status).toBe(200);
        expect(mockedFetch).toHaveBeenCalledTimes(3);
        expect(mockedFetch).toHaveBeenLastCalledWith(
            "https://api.intra.42.fr/v2/me",
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fresh-tok' }) }));
    });

    it("returns the original 401 (does not reject) when the token endpoint refuses the key", async () => {
        // Regression: the token used to be re-minted lazily inside the retried request, so a dead
        // key made get()/post() reject with "Error getting access token" instead of returning the 401.
        mockedFetch
            .mockResolvedValueOnce(res(401) as any)
            .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' } as any);

        const result = await newApi().get("/me");

        expect(result.status).toBe(401);
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect((newApi() as any)._pendingTokens.size).toBe(0);
    });

    it("returns the original 401 for writes too", async () => {
        mockedFetch
            .mockResolvedValueOnce(res(401) as any)
            .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

        const result = await newApi().post("/me", { a: 1 });

        expect(result.status).toBe(401);
        expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
});

describe("postWithUserAccessToken", () => {
    it("uses the caller's token verbatim and keeps it out of the token cache", async () => {
        const api = new Fast42([{ client_id, client_secret }]);
        (api as any)._limiterPairs = [{
            appId: 7,
            limiter: { schedule: (_opts: any, fn: () => Promise<any>) => fn() },
            secret: { client_id, client_secret },
            tokenIndex: 0,
            jobOptions: {},
        }];
        mockedFetch
            // getRateLimits, used to find the limiter belonging to this app
            .mockResolvedValueOnce({ ok: true, headers: { get: (h: string) => (h === 'x-application-id' ? '7' : '10') } } as any)
            // the actual POST
            .mockResolvedValueOnce({ status: 201, ok: true, headers: { get: () => null } } as any);

        const result = await api.postWithUserAccessToken('user-token', '/me', { a: 1 });

        expect(result.status).toBe(201);
        expect(mockedFetch).toHaveBeenLastCalledWith(
            "https://api.intra.42.fr/v2/me",
            expect.objectContaining({
                headers: expect.objectContaining({ 'Authorization': 'Bearer user-token' }),
            }));
        expect((api as any)._cache.keys()).toEqual([]);
    });
});

describe("download", () => {
    const token = {
        access_token: 'cdn-tok',
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'public projects',
        created_at: Math.floor(Date.now() / 1000),
    };
    const schedule = jest.fn((_opts: any, fn: () => Promise<any>) => fn());
    const newApi = () => {
        const api = new Fast42([{ client_id, client_secret }], { retry: { jitter: 0, serverErrorBackoff: 0, retryAfterFallback: 0 } });
        (api as any)._limiterPairs = [{
            appId: 1,
            limiter: { schedule },
            secret: { client_id, client_secret },
            tokenIndex: 0,
            jobOptions: {},
        }];
        (api as any).storeToken(token, 0);
        return api;
    };
    const fileResponse = (status = 200) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null } });

    beforeEach(() => schedule.mockClear());

    it("fetches an absolute CDN URL with the API access token as bearer", async () => {
        mockedFetch.mockResolvedValueOnce(fileResponse() as any);

        const result = await newApi().download("https://cdn.intra.42.fr/users/abc.jpg");

        expect(result.status).toBe(200);
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch).toHaveBeenCalledWith(
            "https://cdn.intra.42.fr/users/abc.jpg",
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({ Authorization: 'Bearer cdn-tok' }),
            }));
    });

    it("resolves a CDN-relative path against the CDN root", async () => {
        mockedFetch.mockResolvedValueOnce(fileResponse() as any);

        await newApi().download("/users/abc.jpg");

        expect(mockedFetch).toHaveBeenCalledWith(
            "https://cdn.intra.42.fr/users/abc.jpg",
            expect.anything());
    });

    it("refuses to send the access token to any other origin", async () => {
        const api = newApi();

        await expect(api.download("https://evil.example.com/users/abc.jpg")).rejects.toThrow(/only fetches from https:\/\/cdn.intra.42.fr/);
        // Plain http would send the bearer token in the clear.
        await expect(api.download("http://cdn.intra.42.fr/users/abc.jpg")).rejects.toThrow(/only fetches from https:\/\/cdn.intra.42.fr/);
        // A host that merely starts with the CDN host name is not the CDN either.
        await expect(api.download("https://cdn.intra.42.fr.example.com/x.jpg")).rejects.toThrow(/only fetches from https:\/\/cdn.intra.42.fr/);
        expect(mockedFetch).not.toHaveBeenCalled();
    });

    it("does not go through the API rate limiter", async () => {
        mockedFetch.mockResolvedValueOnce(fileResponse() as any);

        await newApi().download("/users/abc.jpg");

        expect(schedule).not.toHaveBeenCalled();
    });

    it("re-authenticates once on a 401 and retries with the new token", async () => {
        mockedFetch
            .mockResolvedValueOnce(fileResponse(401) as any)
            // token refresh
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ...token, access_token: 'fresh-tok' }) } as any)
            .mockResolvedValueOnce(fileResponse() as any);

        const result = await newApi().download("/users/abc.jpg");

        expect(result.status).toBe(200);
        expect(mockedFetch).toHaveBeenCalledTimes(3);
        expect(mockedFetch).toHaveBeenLastCalledWith(
            "https://cdn.intra.42.fr/users/abc.jpg",
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer fresh-tok' }),
            }));
    });

    it("treats the CDN's 403 bearer challenge like a 401 and re-authenticates once", async () => {
        // Observed on cdn.intra.42.fr: a bad token yields 403 (not 401) with a WWW-Authenticate challenge.
        const challenge = 'Bearer realm="42 API", error="invalid_token", error_description="The access token expired"';
        const forbidden = { status: 403, ok: false, headers: { get: (h: string) => (h.toLowerCase() === 'www-authenticate' ? challenge : null) } };
        mockedFetch
            .mockResolvedValueOnce(forbidden as any)
            // token refresh
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ...token, access_token: 'fresh-tok' }) } as any)
            .mockResolvedValueOnce(fileResponse() as any);

        const result = await newApi().download("/users/abc.jpg");

        expect(result.status).toBe(200);
        expect(mockedFetch).toHaveBeenCalledTimes(3);
        expect(mockedFetch).toHaveBeenLastCalledWith(
            "https://cdn.intra.42.fr/users/abc.jpg",
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer fresh-tok' }),
            }));
    });

    it("returns the original 403 when re-authentication fails, instead of rejecting", async () => {
        const challenge = 'Bearer realm="42 API", error="invalid_token"';
        const forbidden = { status: 403, ok: false, headers: { get: (h: string) => (h.toLowerCase() === 'www-authenticate' ? challenge : null) } };
        mockedFetch
            .mockResolvedValueOnce(forbidden as any)
            // token refresh fails: dead key
            .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' } as any);

        const result = await newApi().download("/users/abc.jpg");

        expect(result.status).toBe(403);
        expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it("does not re-authenticate on a plain 403 without a bearer challenge", async () => {
        mockedFetch.mockResolvedValueOnce(fileResponse(403) as any);

        const result = await newApi().download("/users/abc.jpg");

        expect(result.status).toBe(403);
        expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("rejects when Fast42 is not initialized", async () => {
        const api = new Fast42([{ client_id, client_secret }]);
        jest.spyOn(console, 'error').mockImplementationOnce(() => {});

        await expect(api.download("/users/abc.jpg")).rejects.toThrow(/not initialized/);
        expect(mockedFetch).not.toHaveBeenCalled();
    });
});

it("Should default retry settings to enabled with bounded 5xx retries", () => {
    const api = new Fast42([
        {
            client_id: client_id,
            client_secret: client_secret,
        },
    ]);
    expect((api as any)._retry).toEqual({
        enabled: true,
        maxServerErrorRetries: 5,
        serverErrorBackoff: 30000,
        retryAfterFallback: 1,
        jitter: 10000,
    });
})

// it("initializes using real keys", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "localhost",
//         port: 6379,
//         password: undefined,
//     }).init());
//     expect(api).toBeInstanceOf(Fast42);
//     await api.disconnect();
// })

// jest.setTimeout(10000)
// it("Do a job using redis", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "127.0.0.1",
//         port: 6379,
//     }).init());
//     const job = await api.doJob(() => {
//         console.log("Doing job");
//         return new Promise((resolve, reject) => {
//             setTimeout(() => {
//                 resolve("done");
//             }, 1000);
//         })
//     });
//     expect(job).toBe("done");
//     await api.disconnect();
// })

// it("Make 1 request", async () => {
//     const api = await (new Fast42([
//         {
//             client_id: client_id,
//             client_secret: client_secret
//         },
//     ], 0, 2000, {
//         host: "127.0.0.1",
//         port: 6379,
//     }).init());
//     const job = await api.get("/projects/1328");    
//     const item = await job.json();
//     expect(item).toHaveProperty("id");
//     await api.disconnect();
// })
