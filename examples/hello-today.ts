import { Octokit } from "octokit";
import KeyvGithub from "../src/index.ts";

// Authenticate via GITHUB_TOKEN env var (required for writes)
const client = new Octokit({ auth: process.env.GITHUB_TOKEN });

const kv = new KeyvGithub("https://github.com/snomiao/keyv-github/tree/main", { client });

const key = "data/hello-today.txt";
const value = new Date().toISOString();

console.log(`set  ${key} = ${value}`);
await kv.set(key, value);

const read = await kv.get(key);
console.log(`get  ${key} = ${read}`);

console.log(`has  ${key} = ${await kv.has(key)}`);

// Demonstrate path validation — these throw immediately without hitting the API
const invalidPaths = [
  "",
  "/absolute/path",
  "trailing/slash/",
  "double//slash",
  "../escape",
  "a/./b",
];

console.log("\nPath validation:");
for (const bad of invalidPaths) {
  try {
    await kv.get(bad);
  } catch (e: any) {
    console.log(`  ✗ ${JSON.stringify(bad)} → ${e.message}`);
  }
}  
