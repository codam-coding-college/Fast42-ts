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
