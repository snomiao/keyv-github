import { EventEmitter } from "events";
import { Octokit } from "octokit";
import type { KeyvStoreAdapter, StoredData } from "keyv";

export interface KeyvGithubOptions {
  url: string;
  branch?: string;
  client?: Octokit | Octokit["rest"];
  /** Customize the commit message. value is null for deletes. */
  msg?: (key: string, value: string | null) => string;
  /** clear() deletes every file in the repo and is disabled by default. Set to true to allow it. */
  enableClear?: boolean;
}

/**
 * Keyv storage adapter backed by a GitHub repository.
 *
 * Each key is a file path in the repo; the file content is the value.
 * Example: new KeyvGithub("https://github.com/owner/repo/tree/main", { client })
 */
export default class KeyvGithub extends EventEmitter implements KeyvStoreAdapter {
  opts: KeyvGithubOptions;
  namespace?: string;

  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  client: Octokit;
  rest: Octokit["rest"];
  private msg: (key: string, value: string | null) => string;
  readonly enableClear: boolean;

  constructor(url: string, options: Omit<KeyvGithubOptions, "url"> = {}) {
    super();
    // github.com prefix is optional: "owner/repo/tree/branch" works too
    // RegExp string avoids native-TS-preview parser issues with char classes containing ? or #
    const match = url.match(new RegExp("(?:.*github\\.com[/:])?([^/:]+)/([^/]+?)(?:\\.git)?(?:/tree/([^?#]+))?(?:[?#].*)?$"));
    if (!match) throw new Error(`Invalid GitHub repo URL: ${url}`);
    this.owner = match[1]!;
    this.repo = match[2]!;
    this.branch = options.branch ?? match[3] ?? "main";
    this.opts = { url, ...options };
    this.client = options.client instanceof Octokit ? options.client : options.client ?? new Octokit();
    this.rest = this.client.rest;
    this.msg = options.msg ?? ((key, value) => value === null ? `delete ${key}` : `update ${key}`);
    this.enableClear = options.enableClear ?? false;
  }

  private static isHttpError(e: unknown): e is { status: number } {
    return typeof e === "object" && e !== null && "status" in e && typeof (e as Record<string, unknown>).status === "number";
  }

  private validateKey(key: string): void {
    if (!key) throw new Error("Key must not be empty");
    if (key.startsWith("/")) throw new Error(`Key must not start with '/': ${key}`);
    if (key.endsWith("/")) throw new Error(`Key must not end with '/': ${key}`);
    if (key.includes("//")) throw new Error(`Key must not contain '//': ${key}`);
    if (key.includes("\0")) throw new Error(`Key must not contain null bytes: ${key}`);
    if (key.split("/").some((seg) => seg === ".." || seg === "."))
      throw new Error(`Key must not contain '.' or '..' segments: ${key}`);
  }

  async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
    this.validateKey(key);
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== "file") return undefined;
      return Buffer.from(data.content, "base64").toString("utf-8") as StoredData<Value>;
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) return undefined;
      throw e;
    }
  }

  async set(key: string, value: any, _ttl?: number): Promise<void> {
    this.validateKey(key);
    let sha: string | undefined;
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      if (!Array.isArray(data) && data.type === "file") sha = data.sha;
    } catch (e: unknown) {
      if (!KeyvGithub.isHttpError(e) || e.status !== 404) throw e;
    }

    await this.client.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: key,
      message: this.msg(key, value),
      content: Buffer.from(String(value)).toString("base64"),
      sha,
      branch: this.branch,
    });
  }

  async delete(key: string): Promise<boolean> {
    this.validateKey(key);
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== "file") return false;
      await this.client.rest.repos.deleteFile({
        owner: this.owner,
        repo: this.repo,
        path: key,
        message: this.msg(key, null),
        sha: data.sha,
        branch: this.branch,
      });
      return true;
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) return false;
      throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    this.validateKey(key);
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      return !Array.isArray(data) && data.type === "file";
    } catch (e: unknown) {
      if (KeyvGithub.isHttpError(e) && e.status === 404) return false;
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

    const { data: refData } = await this.client.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const headSha = refData.object.sha;

    const { data: commitData } = await this.client.rest.git.getCommit({
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

    const { data: newTree } = await this.client.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: commitData.tree.sha,
      tree: treeEntries,
    });

    const { data: newCommit } = await this.client.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message,
      tree: newTree.sha,
      parents: [headSha],
    });

    await this.client.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
      sha: newCommit.sha,
    });
  }

  /** Keyv batch-set: writes multiple keys in a single commit (5 API calls total). */
  async setMany(values: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    if (values.length === 0) return;
    const entries: [string, string][] = values.map(({ key, value }) => [key, String(value)]);
    for (const [key] of entries) this.validateKey(key);
    const message =
      entries.length === 1
        ? this.msg(entries[0]![0], entries[0]![1])
        : `batch update ${entries.length} files`;
    await this._batchCommit({ set: entries, message });
  }

  /**
   * Keyv batch-delete: deletes multiple keys in a single commit (7 API calls total).
   * Returns true if any keys were deleted.
   */
  async deleteMany(keys: string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    for (const key of keys) this.validateKey(key);

    const { data: refData } = await this.client.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const { data: treeData } = await this.client.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });
    const existingPaths = new Set(
      treeData.tree.filter((i) => i.type === "blob" && i.path).map((i) => i.path!)
    );

    const toDelete = keys.filter((k) => existingPaths.has(k));
    if (toDelete.length === 0) return false;

    const message =
      toDelete.length === 1
        ? this.msg(toDelete[0]!, null)
        : `batch delete ${toDelete.length} files`;
    await this._batchCommit({ delete: toDelete, message });
    return true;
  }

  async clear(): Promise<void> {
    if (!this.enableClear)
      throw new Error("clear() is disabled. Set enableClear: true in options to allow it.");

    const { data: refData } = await this.client.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const { data: treeData } = await this.client.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });

    const allPaths = treeData.tree
      .filter((i) => i.type === "blob" && i.path)
      .map((i) => i.path!);

    if (allPaths.length > 0) {
      await this._batchCommit({
        delete: allPaths,
        message: `clear: remove ${allPaths.length} files`,
      });
    }
  }

  async *iterator<Value>(prefix?: string): AsyncGenerator<[string, Value | undefined]> {
    const { data: refData } = await this.client.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.branch}`,
    });
    const { data: treeData } = await this.client.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: refData.object.sha,
      recursive: "1",
    });

    const files = treeData.tree.filter(
      (item) => item.type === "blob" && item.path && (!prefix || item.path.startsWith(prefix))
    );

    for (const file of files) {
      if (file.path) {
        const value = await this.get<Value>(file.path);
        if (value !== undefined) yield [file.path, value as Value];
      }
    }
  }
}
