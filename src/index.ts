import { EventEmitter } from "events";
import type { KeyvStoreAdapter, StoredData } from "keyv";
import { Octokit } from "octokit";

/** Minimal Map-like interface for SHA caching. */
export interface ShaMap {
  get(key: string): string | null | undefined;
  set(key: string, value: string | null): void;
}

export interface KeyvGithubOptions {
  url: string;
  branch?: string;
  client?: Octokit | Octokit["rest"];
  /**
   * Customize the commit message for single-key operations. value is null for deletes.
   * @warning Consider adding `[skip ci]` to your commit messages to prevent
   * triggering CI workflows on each key-value update.
   */
  msg?: (key: string, value: string | null) => string;
  /**
   * Customize the commit message for batch operations (setMany, deleteMany, clear).
   * @param operation - 'set' | 'delete' | 'clear'
   * @param paths - array of file paths being modified
   * @warning Consider adding `[skip ci]` to your commit messages to prevent
   * triggering CI workflows on each key-value update.
   */
  batchMsg?: (operation: "set" | "delete" | "clear", paths: string[]) => string;
  /** clear() deletes every file in the repo and is disabled by default. Set to true to allow it. */
  enableClear?: boolean;
  /** Path prefix prepended to every key (e.g. 'data/'). Defaults to ''. */
  prefix?: string;
  /** Path suffix appended to every key (e.g. '.json'). Defaults to ''. */
  suffix?: string;
  /** SHA cache map. Defaults to new Map(). Pass any keyv-like object with get/set. */
  shaMap?: ShaMap;
}

/**
 * Keyv storage adapter backed by a GitHub repository.
 *
 * Each key is a file path in the repo; the file content is the value.
 * Example: new KeyvGithub("https://github.com/owner/repo/tree/main", { client })
 *
 * @warning **Keys are validated but NOT sanitized.** You must ensure keys are valid
 * GitHub file paths before calling any method. Invalid keys throw an error.
 * Requirements: non-empty, no leading/trailing `/`, no `//`, no `.`/`..` segments, no null bytes.
 */
export default class KeyvGithub extends EventEmitter implements KeyvStoreAdapter {
  opts: KeyvGithubOptions;
  namespace?: string;

  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  /** Alias for {@link ref}. */
  get branch(): string {
    return this.ref;
  }
  rest: Octokit["rest"];
  private msg: (key: string, value: string | null) => string;
  private batchMsg: (operation: "set" | "delete" | "clear", paths: string[]) => string;
  readonly enableClear: boolean;
  readonly prefix: string;
  readonly suffix: string;
  /** SHA cache: key → sha (string), null (file doesn't exist), undefined (unknown). */
  readonly shaMap: ShaMap;

  constructor(url: string, options: Omit<KeyvGithubOptions, "url"> = {}) {
    super();
    // github.com prefix is optional: "owner/repo/tree/branch" works too
    // RegExp string avoids native-TS-preview parser issues with char classes containing ? or #
    const match = url.match(
      /(?:.*github\.com[/:])?([^/:]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^?#]+))?(?:[?#].*)?$/,
    );
    if (!match) throw new Error(`Invalid GitHub repo URL: ${url}`);
    this.owner = match[1]!;
    this.repo = match[2]!;
    this.ref = options.branch ?? match[3] ?? "main";
    this.opts = { url, ...options };
    this.rest =
      options.client instanceof Octokit
        ? options.client.rest
        : (options.client ?? new Octokit().rest);
    this.msg =
      options.msg ?? ((key, value) => (value === null ? `delete ${key} [skip ci]` : `update ${key} [skip ci]`));
    this.batchMsg =
      options.batchMsg ??
      ((op, paths) => {
        const n = paths.length;
        if (op === "clear") return `clear: remove ${n} files [skip ci]`;
        return `batch ${op} ${n} files [skip ci]`;
      });
    this.enableClear = options.enableClear ?? false;
    this.prefix = options.prefix ?? "";
    this.suffix = options.suffix ?? "";
    this.shaMap = options.shaMap ?? new Map<string, string | null>();
  }

  /** Converts a user key to the GitHub file path. */
  private toPath(key: string): string {
    return this.prefix + key + this.suffix;
  }

  /**
   * Converts a GitHub file path back to a user key.
   * Returns null if the path does not match the configured prefix/suffix.
   */
  private fromPath(path: string): string | null {
    if (!path.startsWith(this.prefix) || !path.endsWith(this.suffix)) return null;
    const end = this.suffix ? path.length - this.suffix.length : undefined;
    return path.slice(this.prefix.length, end);
  }

  private static isHttpError(e: unknown): e is { status: number } {
    return (
      typeof e === "object" &&
      e !== null &&
      "status" in e &&
      typeof (e as Record<string, unknown>).status === "number"
    );
  }

  private validatePath(path: string): void {
    if (!path) throw new Error("Path must not be empty");
    if (path.startsWith("/")) throw new Error(`Path must not start with '/': ${path}`);
    if (path.endsWith("/")) throw new Error(`Path must not end with '/': ${path}`);
    if (path.includes("//")) throw new Error(`Path must not contain '//': ${path}`);
    if (path.includes("\0")) throw new Error(`Path must not contain null bytes: ${path}`);
    if (path.split("/").some((seg) => seg === ".." || seg === "."))
      throw new Error(`Path must not contain '.' or '..' segments: ${path}`);
  }

  async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
    const path = this.toPath(key);
    this.validatePath(path);
    try {
      const { data } = await this.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.ref,
      });
      if (Array.isArray(data) || data.type !== "file") {
        this.shaMap.set(path, null);
        return undefined;
      }
      this.shaMap.set(path, data.sha);
      return Buffer.from(data.content, "base64").toString("utf-8") as StoredData<Value>;
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) {
        this.shaMap.set(path, null);
        return undefined;
      }
      throw e;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (ttl !== undefined) {
      throw new Error(
        "TTL is not supported natively by keyv-github. " +
        "Use new Keyv(store) which handles TTL via value expiration metadata.",
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        "keyv-github only supports string values natively. " +
        "Use new Keyv(store) which serializes values automatically.",
      );
    }
    const path = this.toPath(key);
    this.validatePath(path);

    // Check shaMap first; if unknown (undefined), fetch to populate it
    let cachedSha = this.shaMap.get(path);
    if (cachedSha === undefined) {
      await this.get(key); // populates shaMap
      cachedSha = this.shaMap.get(path);
    }
    // cachedSha is now string (existing file) or null (doesn't exist)
    const sha = cachedSha ?? undefined;

    const { data } = await this.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path,
      message: this.msg(path, value),
      content: Buffer.from(String(value)).toString("base64"),
      sha,
      branch: this.ref,
    });
    // Update shaMap with new sha from response
    this.shaMap.set(path, data.content?.sha ?? null);
  }

  async delete(key: string): Promise<boolean> {
    const path = this.toPath(key);
    this.validatePath(path);

    // Check shaMap first; if unknown (undefined), fetch to populate it
    let cachedSha = this.shaMap.get(path);
    if (cachedSha === undefined) {
      await this.get(key); // populates shaMap
      cachedSha = this.shaMap.get(path);
    }
    // If null or still undefined, file doesn't exist
    if (!cachedSha) return false;

    const sha = cachedSha; // narrow to string for TypeScript
    try {
      await this.rest.repos.deleteFile({
        owner: this.owner,
        repo: this.repo,
        path,
        message: this.msg(path, null),
        sha,
        branch: this.ref,
      });
      this.shaMap.set(path, null);
      return true;
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) {
        this.shaMap.set(path, null);
        return false;
      }
      throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    const path = this.toPath(key);
    this.validatePath(path);
    try {
      const { data } = await this.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.ref,
      });
      if (Array.isArray(data) || data.type !== "file") {
        this.shaMap.set(path, null);
        return false;
      }
      this.shaMap.set(path, data.sha);
      return true;
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) {
        this.shaMap.set(path, null);
        return false;
      }
      throw e;
    }
  }

  /**
   * Commit multiple file changes in one roundtrip: 5 API calls for any N.
   * set entries: written inline into the tree (no separate blob creation).
   * delete paths: removed by setting sha: null in the tree.
   */
  private async _batchCommit(params: {
    set?: [string, string][];
    delete?: string[];
    message: string;
  }): Promise<void> {
    const { set = [], delete: del = [], message } = params;

    const { data: refData } = await this.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const headSha = refData.object.sha;

    const { data: commitData } = await this.rest.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: headSha,
    });

    const treeEntries = [
      ...set.map(([path, content]) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        content,
      })),
      ...del.map((path) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      })),
    ];

    const { data: newTree } = await this.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: commitData.tree.sha,
      tree: treeEntries,
    });

    const { data: newCommit } = await this.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message,
      tree: newTree.sha,
      parents: [headSha],
    });

    await this.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
      sha: newCommit.sha,
    });
  }

  /** Keyv batch-set: writes multiple keys in a single commit (5 API calls total). */
  async setMany(values: Array<{ key: string; value: any }>): Promise<void> {
    if (values.length === 0) return;
    for (const { key, value } of values) {
      if (typeof value !== "string") {
        throw new Error(
          "keyv-github only supports string values natively. " +
          "Use new Keyv(store) which serializes values automatically.",
        );
      }
      this.validatePath(this.toPath(key));
    }
    const entries: [string, string][] = values.map(({ key, value }) => [
      this.toPath(key),
      String(value),
    ]);
    const paths = entries.map(([p]) => p);
    const message =
      entries.length === 1
        ? this.msg(entries[0]![0], entries[0]![1])
        : this.batchMsg("set", paths);
    await this._batchCommit({ set: entries, message });
  }

  /**
   * Keyv batch-delete: deletes multiple keys in a single commit (7 API calls total).
   * Returns true if any keys were deleted.
   */
  async deleteMany(keys: string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    for (const key of keys) this.validatePath(this.toPath(key));

    const { data: refData } = await this.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const { data: treeData } = await this.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });
    const existingPaths = new Set(
      treeData.tree
        .filter((i: { type?: string; path?: string }) => i.type === "blob" && i.path)
        .map((i: { path?: string }) => i.path!),
    );

    const toDelete = keys.map((k) => this.toPath(k)).filter((p) => existingPaths.has(p));
    if (toDelete.length === 0) return false;

    const message =
      toDelete.length === 1
        ? this.msg(toDelete[0]!, null)
        : this.batchMsg("delete", toDelete);
    await this._batchCommit({ delete: toDelete, message });
    return true;
  }

  async clear(): Promise<void> {
    if (!this.enableClear)
      throw new Error("clear() is disabled. Set enableClear: true in options to allow it.");

    const { data: refData } = await this.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const { data: treeData } = await this.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });

    const allPaths = treeData.tree
      .filter(
        (i) =>
          i.type === "blob" &&
          i.path &&
          i.path.startsWith(this.prefix) &&
          i.path.endsWith(this.suffix),
      )
      .map((i) => i.path!);

    if (allPaths.length > 0) {
      await this._batchCommit({
        delete: allPaths,
        message: this.batchMsg("clear", allPaths),
      });
    }
  }

  async *iterator<Value>(prefix?: string): AsyncGenerator<[string, Value | undefined]> {
    const { data: refData } = await this.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const { data: treeData } = await this.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });

    const pathPrefix = this.prefix + (prefix ?? "");
    const files = treeData.tree.filter(
      (item) =>
        item.type === "blob" &&
        item.path &&
        item.path.startsWith(pathPrefix) &&
        item.path.endsWith(this.suffix),
    );

    for (const file of files) {
      if (file.path) {
        const key = this.fromPath(file.path);
        if (key === null || key === "") continue;
        const value = await this.get<Value>(key);
        if (value !== undefined) yield [key, value as Value];
      }
    }
  }
}
