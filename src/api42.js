"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api42 = void 0;
const bottleneck_1 = __importDefault(require("bottleneck"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const node_cache_1 = __importDefault(require("node-cache"));
class api42 {
    /**
     * Constructs the api42 class
     *
     * @param {ApiSecret[]} secrets Array of ApiSecret objects containing the client_id and client_secret
     *  make sure all keys have the same rate limit. Since the keys are rotated after every call, they are used equally.
     */
    constructor(secrets) {
        if (secrets.length === 0) {
            throw new Error("api42 requires at least one 42 Api Key/Secret pair");
        }
        this._secrets = secrets;
        this._rootUrl = "https://api.intra.42.fr/v2";
        this._cache = new node_cache_1.default();
        this._limiters = [];
        this._keyCount = secrets.length;
        this._currentIndex = 0;
    }
    /*
     *  Public Methods
     */
    async init() {
        for (let index = 0; index < this._keyCount; index++) {
            const secret = this._secrets[index];
            const accessToken = await this.getAccessToken(secret.client_id, secret.client_secret);
            this.storeToken(accessToken, index);
            const limit = await this.getRateLimits(await this.retrieveToken(index));
            this._limiters.push(this.createLimiter(limit));
        }
        console.log(`Limiters length: ${this._limiters.length}`);
        // Schedule a job per limiter to compensate the limiter for the request made earlier to get the rate limits
        for (let i = 0; i < this._limiters.length; i++) {
            this._limiters[i].schedule(() => { return Promise.resolve("limiter initialized"); });
        }
        return this;
    }
    async get(endpoint, options) {
        if (!this._limiters || this._limiters.length <= 0) {
            throw new Error("api42 not initialized, please call .init() first");
        }
        const index = this.getCurrentIndexAndSetNext();
        const accessToken = await this.retrieveToken(index);
        const url = this._rootUrl + endpoint + this.parseOptions(options);
        const response = this.getFromApi(this._limiters[index], accessToken, url);
        return response;
    }
    async getPage(url, page, options) {
        let _options = {};
        if (options) {
            _options = options;
        }
        if (!('page[size]' in _options)) {
            _options['page[size]'] = '100';
        }
        _options['page[number]'] = page;
        return this.get(url, _options);
    }
    async getAllPages(url, options, start = 1) {
        let pageSize = 100;
        if (options && ('page[size]' in options)) {
            pageSize = parseInt(options['page[size]']);
        }
        const _options = Object.assign(Object.assign({}, options), { 'page[number]': start.toString(), 'page[size]': pageSize.toString() });
        const firstPage = await this.get(url, _options);
        const pages = [Promise.resolve(firstPage)];
        if (firstPage.headers.get("x-total") !== null) {
            const totalItems = parseInt(firstPage.headers.get("x-total"));
            const totalPages = Math.ceil(totalItems / pageSize);
            for (let i = start + 1; i <= totalPages; i++) {
                const _options = Object.assign(Object.assign({}, options), { 'page[number]': i.toString(), 'page[size]': pageSize.toString() });
                const page = this.get(url, _options);
                pages.push(page);
            }
        }
        return pages;
    }
    /*
     *  Private Methods
     */
    async getFromApi(limiter, accessToken, url) {
        const response = limiter.schedule(async (accessToken, url) => {
            const response = await (0, node_fetch_1.default)(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken.access_token}`
                }
            });
            return response;
        }, accessToken, url);
        return response;
    }
    parseOptions(options) {
        let optionsString = "";
        if (!options) {
            return optionsString;
        }
        let firstOption = true;
        for (let [key, value] of Object.entries(options)) {
            if (firstOption) {
                optionsString += `?${key}=${value}`;
                firstOption = false;
            }
            else {
                optionsString += `&${key}=${value}`;
            }
        }
        return optionsString;
    }
    async getAccessToken(clientid, clientsecret) {
        const response = await (0, node_fetch_1.default)("https://api.intra.42.fr/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `grant_type=client_credentials&client_id=${clientid}&client_secret=${clientsecret}&scope=projects%20public`
        });
        if (!response.ok) {
            throw new Error(`Error getting access token: ${response.status} ${response.statusText}`);
        }
        const accessToken = await response.json();
        return accessToken;
    }
    storeToken(accessToken, index) {
        this._cache.set(`accessToken-${index}`, accessToken, accessToken.expires_in);
    }
    async retrieveToken(index) {
        const accessToken = this._cache.get(`accessToken-${index}`);
        if (accessToken) {
            return accessToken;
        }
        if (this._secrets[index]) {
            const newToken = await this.getAccessToken(this._secrets[index].client_id, this._secrets[index].client_secret);
            this.storeToken(newToken, index);
            return newToken;
        }
        return Promise.reject(`ApiSecret not found at index: ${index}`);
    }
    getCurrentIndexAndSetNext() {
        const key = this._currentIndex;
        if (this._currentIndex === this._keyCount - 1) {
            this._currentIndex = 0;
        }
        else {
            this._currentIndex += 1;
        }
        return key;
    }
    async getRateLimits(accessToken) {
        const response = await (0, node_fetch_1.default)("https://api.intra.42.fr/v2/cursus", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken.access_token}`
            }
        });
        if (response.ok) {
            const rateLimits = {
                id: parseInt(response.headers.get("x-application-id")),
                hourly_limit: parseInt(response.headers.get("x-hourly-ratelimit-limit")),
                hourly_remaining: parseInt(response.headers.get("x-hourly-ratelimit-remaining")),
                secondly_limit: parseInt(response.headers.get("x-secondly-ratelimit-limit")),
                secondly_remaining: parseInt(response.headers.get("x-secondly-ratelimit-remaining")),
            };
            return rateLimits;
        }
        return Promise.reject(`Error getting rate limits: ${response.status} ${response.statusText}`);
    }
    createLimiter(limit) {
        const limiter = new bottleneck_1.default({
            // Hourly rate limit
            reservoir: limit.hourly_remaining,
            reservoirRefreshAmount: limit.hourly_limit,
            reservoirRefreshInterval: 1000 * 60 * 60,
            // Secondly rate limit
            maxConcurrent: limit.secondly_limit - 1,
            minTime: Math.trunc(1000 / limit.secondly_limit) + 25 // arbitrary slowdown to prevent retries,
        });
        limiter.on("error", (err) => {
            console.error(err);
        });
        return limiter;
    }
}
exports.api42 = api42;
exports.default = api42;
