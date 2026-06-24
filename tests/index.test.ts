import Fast42 from '../src/index';

const client_id = "test";
const client_secret = "test";
const mockedFetch = jest.fn();
global.fetch = mockedFetch as unknown as typeof fetch;

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
