# fast42

Fast 42 connector
Use straight from github:
`npm i --save https://github.com/codam-coding-college/fast42.git`

Basic usage:
```ts
  const api = await new Api42([
    {
      client_id: <YOUR API CLIENT ID>,
      client_secret: <YOUR API CLIENT SECRET>,
    }
  ]).init()
  const campus_id = 14;
  const pages = await api.getAllPages(`/campus/${campus_id}/users`, {
    'filter[campus_id]': campus_id.toString(),
  })
```
Obviously your id/secret should come from the environment (.env file and `dotenv`) and not be committed to git.

How I use it:
```ts
    async function getAll42(api: Api42, url: string, options: { [key: string]: string }, callback: (_: Response) => any) {
    const pages = await api.getAllPages(url, options)
    console.log(`Retrieving ${pages.length} pages for ${url}`)
    return Promise.all(pages.map(async page => {
        let p = await page;
        const pagenr = getPageNumberFromUrl(p.url)
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
    }))
    }
```
