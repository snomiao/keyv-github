# keyv-github

A [Keyv](https://keyv.org/) storage adapter backed by a GitHub repository.

Each **key** is a file path in the repo; the **value** is the file's content.

## ⚠️ WARNING before use this package, beware the GITHUB Rate limits

The GitHub REST API has strict rate limits:

- **Unauthenticated:** 60 requests/hour
- **Authenticated:** 5,000 requests/hour

Every `set` costs **2 API calls** (read SHA + write), every `delete` costs **2** (read SHA + delete), `clear` and `iterator` cost **2 + N** (tree lookup + one call per file). For high-frequency writes, consider batching or using a different store.

Use a [GitHub App](https://docs.github.com/en/developers/apps) token or a fine-grained PAT with `contents: write` permission to maximise your quota.

### Best Practice: Use cache layers

To reduce API calls, chain memory and file caches before keyv-github using [keyv-nest](https://github.com/snomiao/keyv-nest) and [keyv-dir-store](https://github.com/snomiao/keyv-dir-store):

```ts
import Keyv from "keyv";
import KeyvNest from "keyv-nest";
import { KeyvDirStore } from "keyv-dir-store";
import KeyvGithub from "keyv-github";

// Simple memory store (avoids Keyv namespace prefix issues)
const memoryStore = {
  cache: new Map<string, any>(),
  opts: { url: "", dialect: "map" },
  get(key: string) { return this.cache.get(key); },
  set(key: string, value: any) { this.cache.set(key, value); },
  delete(key: string) { return this.cache.delete(key); },
  clear() { this.cache.clear(); },
};

// Use same prefix/suffix so local cache mirrors GitHub paths
const prefix = "data/";
const suffix = ".json";

const store = KeyvNest(
  memoryStore,                             // L1: Memory (fastest)
  new KeyvDirStore("./cache", {            // L2: Local files (fast)
    prefix,
    suffix,
    filename: (k) => k,  // use key as-is, no hashing
  }),
  new KeyvGithub("owner/repo/tree/main", { client, prefix, suffix })  // L3: GitHub
);

// Wrap with Keyv (use empty namespace to preserve keys)
(store as any).opts = { url: "", dialect: "keyv-nest" };
const kv = new Keyv({ store, namespace: "" });
// key "foo" -> ./cache/data/foo.json (local) and data/foo.json (GitHub)
```

See [demo-best-practice.ts](./demo-best-practice.ts) for a runnable example.

Reads check L1 → L2 → L3, with automatic backfill to faster layers on cache miss.

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

| Option   | Type                     | Default                             | Description                                              |
| -------- | ------------------------ | ----------------------------------- | -------------------------------------------------------- |
| `branch` | `string`                 | parsed from URL or `"main"`         | Target branch                                            |
| `client` | `Octokit`                | `new Octokit()`                     | Authenticated Octokit instance                           |
| `msg`    | `(key, value) => string` | `"update <key>"` / `"delete <key>"` | Customize commit messages; `value` is `null` for deletes |
| `prefix` | `string`                 | `""`                                | Path prefix prepended to every key (e.g. `"data/"`)      |
| `suffix` | `string`                 | `""`                                | Path suffix appended to every key (e.g. `".json"`)       |

### Store limitations

When using `KeyvGithub` directly (without wrapping in `Keyv`):

- **Values must be strings** — objects, arrays, and numbers will throw an error
- **TTL is not supported** — passing a TTL parameter throws an error

To store non-string values or use TTL, wrap the store with `new Keyv(store)`:

```ts
// Direct usage: strings only, no TTL
await store.set("key", "string value"); // ✓
await store.set("key", { obj: true });  // ✗ throws error
await store.set("key", "value", 1000);  // ✗ throws error

// With Keyv wrapper: any serializable value, TTL supported
const kv = new Keyv({ store });
await kv.set("key", { obj: true });     // ✓ serialized automatically
await kv.set("key", "value", 1000);     // ✓ TTL handled by Keyv
```

### TTL

TTL is **not enforced at the adapter level** — GitHub has no native file expiry. If you pass a `ttl` to `new Keyv({ store, ttl })`, Keyv handles it by wrapping values as `{"value":…,"expires":…}` and filtering on read. Expired files remain in the repo as inert files until overwritten or deleted. This adapter is best suited for long-lived or permanent storage.

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
    value === null ? `chore: delete ${key}` : `chore: update ${key} → ${value.slice(0, 40)}`,
});
```

## Key rules

⚠️ **Keys are validated but NOT sanitized.** You must sanitize keys yourself before passing them to this adapter. Invalid keys will throw an error.

Keys must be valid relative file paths:

- Non-empty
- No leading or trailing `/`
- No `//` double slashes
- No `.` or `..` segments
- No null bytes

**OS-specific characters** like `<>:"|?*\` (invalid on Windows) are NOT validated — you must sanitize these yourself if your keys might contain them.

Invalid keys throw synchronously before any API request.

```ts
// ✗ These will throw errors
await store.set("/absolute/path", "value");     // leading slash
await store.set("path/", "value");               // trailing slash
await store.set("path/../escape", "value");      // directory traversal
await store.set("path//double", "value");        // double slashes

// ✓ Valid keys
await store.set("data/file.txt", "value");
await store.set("nested/path/key.json", "value");
```

## See Also

Other Keyv storage adapters by the same author:

- [keyv-sqlite](https://github.com/snomiao/keyv-sqlite) — SQLite storage adapter
- [keyv-mongodb-store](https://github.com/snomiao/keyv-mongodb-store) — MongoDB storage adapter
- [keyv-nedb-store](https://github.com/snomiao/keyv-nedb-store) — NeDB embedded file-based adapter
- [keyv-dir-store](https://github.com/snomiao/keyv-dir-store) — file-per-key directory adapter with TTL via mtime
- [keyv-cache-proxy](https://github.com/snomiao/keyv-cache-proxy) — transparent caching proxy that wraps any object
- [keyv-nest](https://github.com/snomiao/keyv-nest) — hierarchical multi-layer caching adapter

## License

MIT
