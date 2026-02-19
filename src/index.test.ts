import { expect, test, describe } from "bun:test";
import KeyvGithub from "./index.ts";

// ── Minimal mock for Octokit REST API ──────────────────────────────────────

type FileRecord = { content: string; sha: string };

function makeMockClient(files: Map<string, FileRecord> = new Map()) {
  let shaCounter = 0;
  const nextSha = () => `sha${++shaCounter}`;

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
    sha: existingSha,
  }: {
    path: string;
    content: string;
    message: string;
    sha?: string;
    branch?: string;
  }) => {
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    const sha = existingSha ?? nextSha();
    files.set(path, { content: decoded, sha });
    return { data: { content: { path, sha } } };
  };

  const deleteFile = async ({
    path,
    sha,
  }: {
    path: string;
    message: string;
    sha: string;
    branch?: string;
  }) => {
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

  return {
    rest: {
      repos: { getContent, createOrUpdateFileContents, deleteFile },
      git: { getRef, getTree },
    },
  } as any;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeStore(files?: Map<string, FileRecord>) {
  const mockFiles = files ?? new Map<string, FileRecord>();
  const client = makeMockClient(mockFiles);
  const store = new KeyvGithub("https://github.com/owner/repo", { branch: "main", client });
  return { store, mockFiles };
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
  test("removes all files", async () => {
    const files = new Map<string, FileRecord>([
      ["a", { content: "1", sha: "s1" }],
      ["b", { content: "2", sha: "s2" }],
      ["c/d", { content: "3", sha: "s3" }],
    ]);
    const { store, mockFiles } = makeStore(files);
    await store.clear();
    expect(mockFiles.size).toBe(0);
  });

  test("no-op on empty store", async () => {
    const { store } = makeStore();
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
