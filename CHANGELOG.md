# [3.0.0](https://github.com/codam-coding-college/Fast42-ts/compare/v2.2.0...v3.0.0) (2026-06-24)


### Features

* auto retry rate limit ([#53](https://github.com/codam-coding-college/Fast42-ts/issues/53)) ([fb335c6](https://github.com/codam-coding-college/Fast42-ts/commit/fb335c6ce5288df5eab7797134f7512c17493f48))
* use native fetch instead of node-fetch ([a878ea2](https://github.com/codam-coding-college/Fast42-ts/commit/a878ea22d3ab97ad489eae532c19e069a5517133))


### BREAKING CHANGES

* node-fetch has been removed. Consumers must run on Node.js 18 or newer, and the exported Response type is now the native (undici) Response rather than node-fetch's. The methods this library uses are identical, but code relying on node-fetch-specific Response behavior (e.g. body as a Node stream) may need adjusting.
