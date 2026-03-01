/**
 * Demo: Best Practice - 3-layer cache with keyv-nest
 *
 * This demo shows how to use memory + file + GitHub cache layers
 * to minimize API calls while keeping data in sync.
 *
 * Run with GitHub:
 *   GITHUB_TOKEN=your_token GITHUB_REPO=owner/repo bun demo-best-practice.ts
 *
 * Run local-only (no GitHub):
 *   bun demo-best-practice.ts --local
 */

import Keyv from "keyv";
import KeyvNest from "keyv-nest";
import { KeyvDirStore } from "keyv-dir-store";
import { Octokit } from "octokit";
import KeyvGithub from "./src/index.ts";

const LOCAL_ONLY = process.argv.includes("--local");
const REPO = process.env.GITHUB_REPO || "snomiao/keyv-github-demo";
const TOKEN = process.env.GITHUB_TOKEN;

if (!LOCAL_ONLY && !TOKEN) {
  console.log("No GITHUB_TOKEN set. Running in local-only mode.");
  console.log("To sync with GitHub, run:");
  console.log("  GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo bun demo-best-practice.ts\n");
}

// Use same prefix/suffix so local cache mirrors GitHub paths
const prefix = "data/";
const suffix = ".txt";

// Simple Map-based memory store (no namespace prefix)
const memoryStore = {
  cache: new Map<string, any>(),
  opts: { url: "", dialect: "map" },
  get(key: string) { return this.cache.get(key); },
  set(key: string, value: any) { this.cache.set(key, value); },
  delete(key: string) { return this.cache.delete(key); },
  clear() { this.cache.clear(); },
};

// Build cache layers
const layers: any[] = [
  memoryStore,                             // L1: Memory (fastest)
  new KeyvDirStore("./cache", {            // L2: Local files (fast)
    prefix,
    suffix,
    filename: (k) => k,  // use key as-is, no hashing
  }),
];

// Add GitHub layer if token is available
if (TOKEN && !LOCAL_ONLY) {
  const client = new Octokit({ auth: TOKEN });
  layers.push(
    new KeyvGithub(`${REPO}/tree/main`, { client, prefix, suffix })  // L3: GitHub
  );
  console.log(`Using 3-layer cache: Memory -> Files -> GitHub (${REPO})`);
} else {
  console.log("Using 2-layer cache: Memory -> Files (local only)");
}

const store = KeyvNest(...layers);
// Add opts for Keyv compatibility
(store as any).opts = { url: "", dialect: "keyv-nest" };
// Use empty namespace to avoid keyv: prefix on keys
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
