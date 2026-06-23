import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverEncoreResources } from "../src/encore.js";

test("Encore metadata discovery includes secrets declared only in source", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-encore-"));
  const fakeBin = path.join(cwd, "bin");
  const backend = path.join(cwd, "backend");
  mkdirSync(path.join(backend, "api"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(backend, "api", "releases.ts"), [
    `import { secret } from "encore.dev/config";`,
    `const discordWebhookUrl = secret("NSTACK_RELEASE_DISCORD_WEBHOOK_URL");`,
    `export function webhook() { return discordWebhookUrl(); }`,
    "",
  ].join("\n"));
  writeFileSync(path.join(fakeBin, "encore"), `#!/usr/bin/env node
const metadata = {
  svcs: [{ name: "api", rel_path: "api", rpcs: [] }],
  sql_databases: [],
  cache_clusters: [{ name: "release-metadata", eviction_policy: "allkeys-lru" }],
  pubsub_topics: [],
  buckets: [],
  pkgs: [{ secrets: ["EXISTING_SECRET"] }],
  cron_jobs: []
};
if (process.argv[2] === "debug" && process.argv[3] === "meta") {
  console.log(JSON.stringify(metadata));
  process.exit(0);
}
process.exit(1);
`);
  chmodSync(path.join(fakeBin, "encore"), 0o755);

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
    const resources = await discoverEncoreResources(backend);
    assert.equal(resources.source, "encore-metadata");
    assert.deepEqual(resources.caches, [{ name: "release-metadata", evictionPolicy: "allkeys-lru" }]);
    assert.deepEqual(resources.secrets, ["EXISTING_SECRET", "NSTACK_RELEASE_DISCORD_WEBHOOK_URL"]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
