/**
 * Example: 3-layer cache (Memory -> Files -> GitHub) with keyv-nest
 *
 * Run:
 *   GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo bun examples/best-today.ts
 */

import Keyv from "keyv";
import KeyvNest from "keyv-nest";
import { KeyvDirStore } from "keyv-dir-store";
import { Octokit } from "octokit";
import KeyvGithub from "../src/index.ts";

const REPO = process.env.GITHUB_REPO || "snomiao/keyv-github-demo";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const prefix = "data/";
const suffix = ".txt";

// L1: Memory cache
const cache = new Map<string, string>();
const memoryStore = {
  opts: { url: "", dialect: "map" },
  get: (key: string) => cache.get(key),
  set: (key: string, value: string) => cache.set(key, value),
  delete: (key: string) => cache.delete(key),
  clear: () => cache.clear(),
};

// L2: File cache
const fileStore = new KeyvDirStore("./cache", { prefix, suffix, filename: (k: string) => k });

// L3: GitHub
const githubStore = new KeyvGithub(`${REPO}/tree/main`, {
  client: new Octokit({ auth: TOKEN }),
  prefix,
  suffix,
});

// Nested: L1 -> L2 -> L3
const store = KeyvNest(memoryStore, fileStore, githubStore);
store.opts = { url: "", dialect: "keyv-nest" };
const kv = new Keyv({ store, namespace: "" });

// Demo
const today = new Date().toISOString().split("T")[0];
await kv.set("best-today", `Today's best: ${today}\nWritten: ${new Date().toISOString()}`);

const result = await kv.get("best-today");
console.log("Content:", result);
console.log(`\nLocal:  ./cache/${prefix}best-today${suffix}`);
console.log(`GitHub: https://github.com/${REPO}/blob/main/${prefix}best-today${suffix}`);
