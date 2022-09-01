# Fast42

Fast TS/JS connector to the 42API, for server-side use.

Features:
- Fast! Gets the most out of your rate-limit, so you don't have to wait forever.
- Automatically determines the rate limit of your API key.
- Queues requests (using bottleneck)
- Multi-key support (be carefull, it might be too fast! 🚀)
- Convenience: fetch all pages from an endpoint with a single method call!

Public Methods:
```ts
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
    let p = await page;
    const pagenr = getPageNumberFromUrl(p.url);
    // retry when the ratelimit was hit
    // (this can happen because the timing on 42api side is different from the timing of the Fast42 ratelimiter)
    if (p.status === 429) {
      if (pagenr) {
        p = await api.getPage(url, pagenr, options);
      } else {
        console.error(`Failed retry on unkown page for ${url}`);
      }
    }
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
  ], 1).init()
  await getAll42Cursus(api);
}
```
