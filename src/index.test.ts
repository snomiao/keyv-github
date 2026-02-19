import { expect, test, describe } from "bun:test";
import KeyvGithub from "./index.ts";

// ── Minimal mock for Octokit REST API ──────────────────────────────────────

type FileRecord = { content: string; sha: string };

function makeMockClient(files: Map<string, FileRecord> = new Map()) {
  let shaCounter = 0;
  const nextSha = () => `sha${++shaCounter}`;
  const messages: string[] = [];

  const getContent = async ({ path, ref: _ref }: { path: string; ref?: string }) => {
    const file = files.get(path);
    if (!file) {
      const err: any = new Error("Not Found");
      err.status = 404;
      throw err;
    }
    return {
      data: {
        type: "file" as const,
        content: Buffer.from(file.content).toString("base64"),
        sha: file.sha,
        name: path.split("/").pop()!,
        path,
      },
    };
  };

  const createOrUpdateFileContents = async ({
    path,
    content,
    message,
    sha: existingSha,
  }: {
    path: string;
    content: string;
    message: string;
    sha?: string;
    branch?: string;
  }) => {
    messages.push(message);
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    const sha = existingSha ?? nextSha();
    files.set(path, { content: decoded, sha });
    return { data: { content: { path, sha } } };
  };

  const deleteFile = async ({
    path,
    message,
    sha,
  }: {
    path: string;
    message: string;
    sha: string;
    branch?: string;
  }) => {
    messages.push(message);
    const file = files.get(path);
    if (!file || file.sha !== sha) {
      const err: any = new Error("Not Found");
      err.status = 404;
      throw err;
    }
    files.delete(path);
    return { data: {} };
  };

  // For clear() / iterator() – git tree
  const getRef = async () => ({ data: { object: { sha: "tree-root-sha" } } });

  const getTree = async ({ recursive }: { tree_sha: string; recursive?: string }) => {
    const blobs = Array.from(files.entries()).map(([path]) => ({
      type: "blob" as const,
      path,
    }));
    return { data: { tree: blobs, truncated: false } };
  };

  const mock = {
    rest: {
      repos: { getContent, createOrUpdateFileContents, deleteFile },
      git: { getRef, getTree },
    },
    messages,
  } as any;
  return mock;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeStore(files?: Map<string, FileRecord>, options?: Parameters<typeof KeyvGithub.prototype.constructor>[1]) {
  const mockFiles = files ?? new Map<string, FileRecord>();
  const client = makeMockClient(mockFiles);
  const store = new KeyvGithub("https://github.com/owner/repo", { branch: "main", client, ...options });
  return { store, mockFiles, messages: client.messages as string[] };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("KeyvGithub constructor", () => {
  test("parses HTTPS GitHub URL", () => {
    const client = makeMockClient();
    expect(
      () => new KeyvGithub("https://github.com/owner/repo", { client })
    ).not.toThrow();
  });

  test("parses SSH-style GitHub URL", () => {
    const client = makeMockClient();
    expect(
      () => new KeyvGithub("git@github.com:owner/repo.git", { client })
    ).not.toThrow();
  });

  test("throws when no owner/repo can be parsed", () => {
    expect(() => new KeyvGithub("notarepo")).toThrow("Invalid GitHub repo URL");
  });

  test("accepts short owner/repo form without github.com prefix", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("owner/repo", { client });
    expect(store.owner).toBe("owner");
    expect(store.repo).toBe("repo");
  });

  test("accepts short owner/repo/tree/branch form", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("owner/repo/tree/main", { client });
    expect(store.owner).toBe("owner");
    expect(store.repo).toBe("repo");
    expect(store.branch).toBe("main");
  });

  test("parses branch from /tree/<branch> in URL", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("https://github.com/owner/repo/tree/develop", { client });
    expect(store.branch).toBe("develop");
  });

  test("parses multi-segment branch from URL", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("https://github.com/owner/repo/tree/feature/my-branch", { client });
    expect(store.branch).toBe("feature/my-branch");
  });

  test("options.branch overrides URL branch", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("https://github.com/owner/repo/tree/develop", {
      client,
      branch: "override",
    });
    expect(store.branch).toBe("override");
  });

  test("defaults to main when no branch in URL or options", () => {
    const client = makeMockClient();
    const store = new KeyvGithub("https://github.com/owner/repo", { client });
    expect(store.branch).toBe("main");
  });
});

describe("key validation", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["/absolute", "start with '/'"],
    ["trailing/", "end with '/'"],
    ["double//slash", "contain '//'"],
    ["../escape", "'..' segment"],
    ["a/./b", "'.' segment"],
    ["null\0byte", "null bytes"],
  ];

  for (const [bad] of cases) {
    test(`throws for ${JSON.stringify(bad)}`, async () => {
      const { store } = makeStore();
      expect(store.get(bad)).rejects.toThrow();
      expect(store.set(bad, "v")).rejects.toThrow();
      expect(store.delete(bad)).rejects.toThrow();
      expect(store.has(bad)).rejects.toThrow();
    });
  }

  test("accepts valid paths", async () => {
    const { store } = makeStore();
    const validPaths = ["simple", "data/file.txt", "a/b/c/d.json", "deep/nested/path"];
    for (const path of validPaths) {
      expect(await store.get(path)).toBeUndefined();
    }
  });
});

describe("get", () => {
  test("returns undefined for missing key", async () => {
    const { store } = makeStore();
    expect(await store.get("missing/key")).toBeUndefined();
  });

  test("returns file content for existing key", async () => {
    const files = new Map([["data/hello", { content: "world", sha: "abc" }]]);
    const { store } = makeStore(files);
    expect(await store.get("data/hello")).toBe("world");
  });
});

describe("set", () => {
  test("creates a new file", async () => {
    const { store, mockFiles } = makeStore();
    await store.set("notes/foo", "bar");
    expect(mockFiles.get("notes/foo")?.content).toBe("bar");
  });

  test("updates an existing file preserving key", async () => {
    const files = new Map([["notes/foo", { content: "old", sha: "sha1" }]]);
    const { store, mockFiles } = makeStore(files);
    await store.set("notes/foo", "new");
    expect(mockFiles.get("notes/foo")?.content).toBe("new");
  });

  test("stores arbitrary unicode values", async () => {
    const { store, mockFiles } = makeStore();
    await store.set("unicode", "日本語テスト 🎉");
    expect(mockFiles.get("unicode")?.content).toBe("日本語テスト 🎉");
  });
});

describe("delete", () => {
  test("returns false for missing key", async () => {
    const { store } = makeStore();
    expect(await store.delete("nope")).toBe(false);
  });

  test("deletes existing key and returns true", async () => {
    const files = new Map([["remove/me", { content: "v", sha: "s1" }]]);
    const { store, mockFiles } = makeStore(files);
    const result = await store.delete("remove/me");
    expect(result).toBe(true);
    expect(mockFiles.has("remove/me")).toBe(false);
  });
});

describe("has", () => {
  test("returns false when key does not exist", async () => {
    const { store } = makeStore();
    expect(await store.has("ghost")).toBe(false);
  });

  test("returns true when key exists", async () => {
    const files = new Map([["present", { content: "yes", sha: "s" }]]);
    const { store } = makeStore(files);
    expect(await store.has("present")).toBe(true);
  });
});

describe("clear", () => {
  test("throws by default (enableClear not set)", async () => {
    const { store } = makeStore();
    expect(store.clear()).rejects.toThrow("enableClear");
  });

  test("throws when enableClear is false", async () => {
    const { store } = makeStore(undefined, { enableClear: false });
    expect(store.clear()).rejects.toThrow("enableClear");
  });

  test("removes all files when enableClear is true", async () => {
    const files = new Map<string, FileRecord>([
      ["a", { content: "1", sha: "s1" }],
      ["b", { content: "2", sha: "s2" }],
      ["c/d", { content: "3", sha: "s3" }],
    ]);
    const { store, mockFiles } = makeStore(files, { enableClear: true });
    await store.clear();
    expect(mockFiles.size).toBe(0);
  });

  test("no-op on empty store when enableClear is true", async () => {
    const { store } = makeStore(undefined, { enableClear: true });
    await store.clear(); // should not throw
  });
});

describe("iterator", () => {
  test("yields all key-value pairs", async () => {
    const files = new Map<string, FileRecord>([
      ["x", { content: "1", sha: "s1" }],
      ["y/z", { content: "2", sha: "s2" }],
    ]);
    const { store } = makeStore(files);
    const results: [string, string][] = [];
    for await (const entry of store.iterator()) {
      results.push(entry);
    }
    expect(results.length).toBe(2);
    expect(results.find(([k]) => k === "x")?.[1]).toBe("1");
    expect(results.find(([k]) => k === "y/z")?.[1]).toBe("2");
  });

  test("filters by prefix when provided", async () => {
    const files = new Map<string, FileRecord>([
      ["ns/a", { content: "1", sha: "s1" }],
      ["ns/b", { content: "2", sha: "s2" }],
      ["other/c", { content: "3", sha: "s3" }],
    ]);
    const { store } = makeStore(files);
    const results: [string, string][] = [];
    for await (const entry of store.iterator("ns/")) {
      results.push(entry);
    }
    expect(results.length).toBe(2);
    expect(results.every(([k]) => k.startsWith("ns/"))).toBe(true);
  });
});

describe("msg hook", () => {
  test("custom msg is called with key and value on set", async () => {
    const calls: [string, string | null][] = [];
    const { store, messages } = makeStore(undefined, {
      msg: (key, value) => { calls.push([key, value]); return `chore: put ${key}`; },
    });
    await store.set("notes/foo", "bar");
    expect(calls).toEqual([["notes/foo", "bar"]]);
    expect(messages[messages.length - 1]).toBe("chore: put notes/foo");
  });

  test("custom msg is called with key and null on delete", async () => {
    const calls: [string, string | null][] = [];
    const files = new Map([["to/remove", { content: "v", sha: "s1" }]]);
    const { store, messages } = makeStore(files, {
      msg: (key, value) => { calls.push([key, value]); return `chore: rm ${key}`; },
    });
    await store.delete("to/remove");
    expect(calls).toEqual([["to/remove", null]]);
    expect(messages[messages.length - 1]).toBe("chore: rm to/remove");
  });

  test("default msg falls back to 'update <key>' / 'delete <key>'", async () => {
    const { store, messages } = makeStore();
    await store.set("k", "v");
    expect(messages[messages.length - 1]).toBe("update k");

    const files2 = new Map([["k2", { content: "v", sha: "s1" }]]);
    const { store: store2, messages: messages2 } = makeStore(files2);
    await store2.delete("k2");
    expect(messages2[messages2.length - 1]).toBe("delete k2");
  });
});

describe("integration with Keyv", () => {
  test("works as a Keyv storage adapter", async () => {
    const { default: Keyv } = await import("keyv");
    const { store } = makeStore();
    const keyv = new Keyv({ store });

    await keyv.set("greeting", "hello");
    expect(await keyv.get("greeting") as unknown).toBe("hello");

    await keyv.delete("greeting");
    expect(await keyv.get("greeting") as unknown).toBe(undefined);
  });
});
