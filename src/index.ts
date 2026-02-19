import { Octokit } from "octokit";

export interface KeyvGithubOptions {
  branch?: string;
  client?: Octokit;
}

/**
 * Keyv storage adapter backed by a GitHub repository.
 *
 * Each key is a file path in the repo; the file content is the value.
 * Example: new KeyvGithub("https://github.com/owner/repo", { branch: "main" })
 */
export default class KeyvGithub {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  private client: Octokit;

  constructor(repoUrl: string, options: KeyvGithubOptions = {}) {
    // github.com prefix is optional: "owner/repo/tree/branch" works too
    // RegExp string avoids native-TS-preview parser issues with char classes containing ? or #
    const match = repoUrl.match(new RegExp("(?:.*github\\.com[/:])?([^/:]+)/([^/]+?)(?:\\.git)?(?:/tree/([^?#]+))?(?:[?#].*)?$"));
    if (!match) throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);
    this.owner = match[1]!;
    this.repo = match[2]!;
    this.branch = options.branch ?? match[3] ?? "main";
    this.client = options.client ?? new Octokit();
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== "file") return undefined;
      return Buffer.from(data.content, "base64").toString("utf-8");
    } catch (e: any) {
      if (e.status === 404) return undefined;
      throw e;
    }
  }

  async set(key: string, value: string): Promise<void> {
    let sha: string | undefined;
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      if (!Array.isArray(data) && data.type === "file") sha = data.sha;
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }

    await this.client.rest.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: key,
      message: sha ? `update ${key}` : `create ${key}`,
      content: Buffer.from(value).toString("base64"),
      sha,
      branch: this.branch,
    });
  }

  async delete(key: string): Promise<boolean> {
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
        message: `delete ${key}`,
        sha: data.sha,
        branch: this.branch,
      });
      return true;
    } catch (e: any) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const { data } = await this.client.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: key,
        ref: this.branch,
      });
      return !Array.isArray(data) && data.type === "file";
    } catch (e: any) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async clear(): Promise<void> {
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

    const files = treeData.tree.filter((item) => item.type === "blob" && item.path);
    for (const file of files) {
      if (file.path) await this.delete(file.path);
    }
  }

  async *iterator(prefix?: string): AsyncGenerator<[string, string]> {
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
        const value = await this.get(file.path);
        if (value !== undefined) yield [file.path, value];
      }
    }
  }
}
