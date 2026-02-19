# keyv-github

A [Keyv](https://keyv.org/) storage adapter backed by a GitHub repository.

Each **key** is a file path in the repo; the **value** is the file's content.

## ⚠️ WARNING before use this package, beware the GITHUB Rate limits

The GitHub REST API has strict rate limits:

- **Unauthenticated:** 60 requests/hour
- **Authenticated:** 5,000 requests/hour

Every `set` costs **2 API calls** (read SHA + write), every `delete` costs **2** (read SHA + delete), `clear` and `iterator` cost **2 + N** (tree lookup + one call per file). For high-frequency writes, consider batching or using a different store.

Use a [GitHub App](https://docs.github.com/en/developers/apps) token or a fine-grained PAT with `contents: write` permission to maximise your quota.

## Install

```sh
bun add keyv-github
# or: npm install keyv-github
```

## Usage

```ts
import Keyv from "keyv";
import KeyvGithub from "keyv-github";

const store = new KeyvGithub("https://github.com/owner/repo/tree/main", {
  client: new Octokit({ auth: process.env.GITHUB_TOKEN }), // only required if you want .set(), or .get() in private repo
});

const kv = new Keyv({ store });

await kv.set("data/hello.txt", "world");
console.log(await kv.get("data/hello.txt")); // "world"
await kv.delete("data/hello.txt");
```

## Constructor

```ts
new KeyvGithub(repoUrl, options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `branch` | `string` | parsed from URL or `"main"` | Target branch |
| `client` | `Octokit` | `new Octokit()` | Authenticated Octokit instance |
| `msg` | `(key, value) => string` | `"update <key>"` / `"delete <key>"` | Customize commit messages; `value` is `null` for deletes |

### URL formats accepted

```
https://github.com/owner/repo
https://github.com/owner/repo/tree/my-branch
git@github.com:owner/repo.git
owner/repo
owner/repo/tree/my-branch
```

### Commit message hook

```ts
const store = new KeyvGithub("owner/repo", {
  msg: (key, value) =>
    value === null
      ? `chore: delete ${key}`
      : `chore: update ${key} → ${value.slice(0, 40)}`,
});
```

## Key rules

Keys must be valid relative file paths:

- Non-empty
- No leading or trailing `/`
- No `//` double slashes
- No `.` or `..` segments
- No null bytes

Invalid keys throw synchronously before any API request.

## License

MIT
