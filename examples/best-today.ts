/**
 * Example: Best Practice - 3-layer cache with keyv-nest
 *
 * This example shows how to use memory + file + GitHub cache layers
 * to minimize API calls while keeping data in sync.
 *
 * Run with GitHub:
 *   GITHUB_TOKEN=your_token GITHUB_REPO=owner/repo bun examples/best-today.ts
 *
 * Run local-only (no GitHub):
 *   bun examples/best-today.ts --local
 */

import Keyv from "keyv";
import KeyvNest from "keyv-nest";
import { KeyvDirStore } from "keyv-dir-store";
import { Octokit } from "octokit";
import KeyvGithub from "../src/index.ts";

const LOCAL_ONLY = process.argv.includes("--local");
const REPO = process.env.GITHUB_REPO || "snomiao/keyv-github-demo";
const TOKEN = process.env.GITHUB_TOKEN;

if (!LOCAL_ONLY && !TOKEN) {
  console.log("No GITHUB_TOKEN set. Running in local-only mode.");
  console.log("To sync with GitHub, run:");
  console.log("  GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo bun examples/best-today.ts\n");
}

// Use same prefix/suffix so local cache mirrors GitHub paths
const prefix = "data/";
const suffix = ".txt";

// Simple Map-based memory store (no namespace prefix)
const cache = new Map<string, string>();
const memoryStore = {
  opts: { url: "", dialect: "map" },
  get(key: string) { return cache.get(key); },
  set(key: string, value: string) { cache.set(key, value); },
  delete(key: string) { return cache.delete(key); },
  clear() { cache.clear(); },
};

// L2: Local file cache
const fileStore = new KeyvDirStore("./cache", {
  prefix,
  suffix,
  filename: (k: string) => k,  // use key as-is, no hashing
});

// Build nested store
const store = TOKEN && !LOCAL_ONLY
  ? (() => {
      const client = new Octokit({ auth: TOKEN });
      const githubStore = new KeyvGithub(`${REPO}/tree/main`, { client, prefix, suffix });
      console.log(`Using 3-layer cache: Memory -> Files -> GitHub (${REPO})`);
      return KeyvNest(memoryStore, fileStore, githubStore);  // L1 -> L2 -> L3
    })()
  : (() => {
      console.log("Using 2-layer cache: Memory -> Files (local only)");
      return KeyvNest(memoryStore, fileStore);  // L1 -> L2
    })();

// Add opts for Keyv compatibility and use empty namespace to avoid keyv: prefix
store.opts = { url: "", dialect: "keyv-nest" };
const kv = new Keyv({ store, namespace: "" });

// Demo: Write today's best thing
const today = new Date().toISOString().split("T")[0];
const content = `Today's best thing: ${today}\n\nWritten at: ${new Date().toISOString()}`;

console.log("\nSetting data/best-today.txt...");
await kv.set("best-today", content);

console.log("Reading back from cache layers...");
const result = await kv.get("best-today");
console.log("Content:", result);

console.log("\nDone! Check:");
console.log(`  Local:  ./cache/${prefix}best-today${suffix}`);
if (TOKEN && !LOCAL_ONLY) {
  console.log(`  GitHub: https://github.com/${REPO}/blob/main/${prefix}best-today${suffix}`);
}
