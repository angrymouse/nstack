import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

test("cleanup enables Dokploy cleanup and prunes unused images", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-cleanup-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Cleanup App", slug: "cleanup-app" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=cleanup.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "DOKPLOY_PROJECT=Cleanup Project",
    "DOKPLOY_ENVIRONMENT=production",
    "DOKPLOY_SERVER_ID=server-1",
    "",
  ].join("\n"));

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, body });
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await runCli(["--cwd", cwd, "cleanup", "--json"]);
    assert.equal(report.cleanup.dockerCleanupEnabled, true);
    assert.equal(report.cleanup.stoppedContainersPruned, true);
    assert.equal(report.cleanup.unusedImagesPruned, true);
    assert.equal(report.cleanup.unusedVolumesPruned, true);
    assert.equal(report.cleanup.dockerBuilderCachePruned, true);
    assert.equal(report.deploy.serverId, "server-1");
    assert.equal(report.timings.steps.length, 5);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => [call.method, call.path, call.body]), [
    ["POST", "/api/settings.updateDockerCleanup", { enableDockerCleanup: true, serverId: "server-1" }],
    ["POST", "/api/settings.cleanStoppedContainers", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanUnusedImages", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanUnusedVolumes", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanDockerBuilder", { serverId: "server-1" }],
  ]);
  const json = JSON.parse(output.join("\n"));
  assert.equal(json.cleanup.unusedImagesPruned, true);
  assert.equal(json.cleanup.dockerBuilderCachePruned, true);
});
