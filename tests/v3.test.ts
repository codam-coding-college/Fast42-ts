import { Fast42v3 } from '../src/index';

const config = {
    clientId: "oidc-id",
    clientSecret: "oidc-secret",
    username: "user",
    password: "pass",
};

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

// Builds a stand-in for a fetch Response with a JSON body.
const jsonRes = (body: any, status = 200, headers: { [k: string]: string } = {}) => {
    const res: any = {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
        clone: () => jsonRes(body, status, headers),
    };
    return res;
};

const tokenResponse = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    refresh_expires_in: 7200,
};

// Makes an initialized client whose fetch mock has already answered the initial token request.
const newInitializedClient = async (extra: Partial<typeof config> = {}) => {
    mockedFetch.mockResolvedValueOnce(jsonRes(tokenResponse));
    const api = await new Fast42v3({ ...config, ...extra }).init();
    mockedFetch.mockReset();
    return api;
};

it("Should instantiate", () => {
    const api = new Fast42v3(config);
    expect(api).toBeInstanceOf(Fast42v3);
});

it("Should throw without OIDC client credentials", () => {
    expect(() => new Fast42v3({ ...config, clientId: '' })).toThrow(/clientId/);
});

it("Should throw without username/password", () => {
    expect(() => new Fast42v3({ ...config, password: '' })).toThrow(/username and password/);
});

it("Should authenticate with the password grant on init, using Basic auth", async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(tokenResponse));
    await new Fast42v3(config).init();

    expect(mockedFetch).toHaveBeenCalledWith(
        "https://auth.42.fr/auth/realms/staff-42/protocol/openid-connect/token",
        expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                'Authorization': `Basic ${Buffer.from('oidc-id:oidc-secret').toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            }),
            body: expect.stringContaining('grant_type=password'),
        }),
    );
    const body = mockedFetch.mock.calls[0][1].body as string;
    expect(body).toContain('username=user');
    expect(body).toContain('password=pass');
});

it("Should include the totp in the password grant when provided", async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(tokenResponse));
    await new Fast42v3({ ...config, totp: '123456' }).init();
    expect(mockedFetch.mock.calls[0][1].body).toContain('totp=123456');
});

it("Should allow overriding the token endpoint", async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(tokenResponse));
    await new Fast42v3({ ...config, tokenUrl: 'https://example.com/token' }).init();
    expect(mockedFetch.mock.calls[0][0]).toBe('https://example.com/token');
});

it("Should throw a helpful error when the token request fails", async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes({ error: 'invalid_grant' }, 401, {}));
    await expect(new Fast42v3(config).init()).rejects.toThrow(/Error getting v3 access token: 401/);
});

it("Should build a per-service URL and send the bearer token on get", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({ ok: true }));

    await api.get('pace-system', 'v1', '/milestones');

    expect(mockedFetch).toHaveBeenCalledWith(
        "https://pace-system.42.fr/api/v1/milestones",
        expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({ 'Authorization': 'Bearer access-1' }),
        }),
    );
});

it("Should append query options to the URL", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({}));
    await api.get('chronos', 'v1', '/attendances', { campus_id: '14' });
    expect(mockedFetch.mock.calls[0][0]).toBe('https://chronos.42.fr/api/v1/attendances?campus_id=14');
});

it("Should normalize an endpoint that omits the leading slash", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({}));
    await api.get('freeze', 'v2', 'freezes');
    expect(mockedFetch.mock.calls[0][0]).toBe('https://freeze.42.fr/api/v2/freezes');
});

it("Should send a JSON body and Content-Type on post", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({}, 201));
    await api.post('pace-system', 'v1', '/milestones', { name: 'x' });

    expect(mockedFetch).toHaveBeenCalledWith(
        "https://pace-system.42.fr/api/v1/milestones",
        expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                'Authorization': 'Bearer access-1',
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ name: 'x' }),
        }),
    );
});

it("getPage should set page and default size query params", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({}));
    await api.getPage('pace-system', 'v1', '/milestones', '2');
    expect(mockedFetch.mock.calls[0][0]).toBe('https://pace-system.42.fr/api/v1/milestones?size=100&page=2');
});

it("getAllPages should fan out using the 'pages' field from the body", async () => {
    const api = await newInitializedClient();
    // First page reports 3 total pages; the body is read from a clone so the caller keeps the original.
    mockedFetch.mockResolvedValueOnce(jsonRes({ page: 1, pages: 3, items: [] }));
    mockedFetch.mockResolvedValueOnce(jsonRes({ page: 2, pages: 3, items: [] }));
    mockedFetch.mockResolvedValueOnce(jsonRes({ page: 3, pages: 3, items: [] }));

    const pages = await api.getAllPages('pace-system', 'v1', '/milestones');
    expect(pages).toHaveLength(3);

    const urls = mockedFetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
        'https://pace-system.42.fr/api/v1/milestones?size=100&page=1',
        'https://pace-system.42.fr/api/v1/milestones?size=100&page=2',
        'https://pace-system.42.fr/api/v1/milestones?size=100&page=3',
    ]);

    // The originally returned first page is still consumable.
    const firstBody = await (await pages[0]!).json();
    expect(firstBody).toEqual({ page: 1, pages: 3, items: [] });
});

it("getAllPages should return a single page when there is no pagination metadata", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({ items: [] }));
    const pages = await api.getAllPages('pace-system', 'v1', '/milestones');
    expect(pages).toHaveLength(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
});

it("Should reuse a cached access token across requests (no extra token calls)", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValue(jsonRes({}));
    await api.get('pace-system', 'v1', '/a');
    await api.get('pace-system', 'v1', '/b');
    // Two data calls, zero token calls (token still valid).
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls.every((c) => !String(c[0]).includes('/token'))).toBe(true);
});

it("refreshToken with a totp re-runs the password grant", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({ ...tokenResponse, access_token: 'access-2' }));
    await api.refreshToken('654321');

    const body = mockedFetch.mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=password');
    expect(body).toContain('totp=654321');

    // Subsequent requests use the new token.
    mockedFetch.mockResolvedValueOnce(jsonRes({}));
    await api.get('pace-system', 'v1', '/x');
    expect(mockedFetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer access-2');
});

it("refreshToken without a totp uses the refresh_token grant", async () => {
    const api = await newInitializedClient();
    mockedFetch.mockResolvedValueOnce(jsonRes({ ...tokenResponse, access_token: 'access-3' }));
    await api.refreshToken();

    const body = mockedFetch.mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-1');
});

it("Should reject requests before init()", async () => {
    const api = new Fast42v3(config);
    await expect(api.get('pace-system', 'v1', '/milestones')).rejects.toThrow(/not initialized/);
});
