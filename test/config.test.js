import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig uses local env without leaking it into process env", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nstack-config-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  for (const dir of [first, second]) {
    mkdirSync(path.join(dir, ".nstack"), { recursive: true });
    writeFileSync(path.join(dir, "nstack.config.mjs"), `export default { app: { name: "${path.basename(dir)}", slug: "${path.basename(dir)}" } };\n`);
  }
  writeFileSync(path.join(first, ".nstack", "local.env"), "NSTACK_DOMAIN=first.example.test\nNSTACK_REGISTRY=ghcr.io/acme/first\n");
  writeFileSync(path.join(second, ".nstack", "local.env"), "NSTACK_DOMAIN=second.example.test\nNSTACK_REGISTRY=ghcr.io/acme/second\n");

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    const firstConfig = await loadConfig(first);
    const secondConfig = await loadConfig(second);

    assert.equal(firstConfig.app.domain, "first.example.test");
    assert.equal(firstConfig.deploy.registry, "ghcr.io/acme/first");
    assert.equal(secondConfig.app.domain, "second.example.test");
    assert.equal(secondConfig.deploy.registry, "ghcr.io/acme/second");
    for (const key of envKeys) assert.equal(process.env[key], undefined);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("loadConfig uses target-specific local env overlays", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-config-target-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Target App", slug: "target-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=prod.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/prod",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), [
    "NSTACK_DOMAIN=staging.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/staging",
    "NSTACK_TARGET=staging",
    "",
  ].join("\n"));

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "NSTACK_TARGET"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    const prodConfig = await loadConfig(cwd);
    const stagingConfig = await loadConfig(cwd, { target: "staging" });
    const previewConfig = await loadConfig(cwd, { target: "preview" });

    assert.equal(prodConfig.deploy.target, "prod");
    assert.equal(prodConfig.app.domain, "prod.example.test");
    assert.equal(prodConfig.deploy.registry, "ghcr.io/acme/prod");
    assert.equal(prodConfig.deploy.provider.environmentName, "production");
    assert.equal(stagingConfig.deploy.target, "staging");
    assert.equal(stagingConfig.app.domain, "staging.example.test");
    assert.equal(stagingConfig.deploy.registry, "ghcr.io/acme/staging");
    assert.equal(stagingConfig.deploy.provider.environmentName, "staging");
    assert.equal(previewConfig.deploy.target, "preview");
    assert.equal(previewConfig.app.domain, "");
    assert.equal(previewConfig.deploy.registry, "");
    assert.equal(previewConfig.deploy.provider.environmentName, "preview");
    for (const key of envKeys) assert.equal(process.env[key], undefined);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("loadConfig preserves provider-specific source settings", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-config-source-"));
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Source App", slug: "source-app" },
  deploy: {
    source: {
      sourceType: "gitlab",
      repository: "https://gitlab.example.test/platform/apps/source-app.git",
      branch: "main",
      gitlabId: "gitlab-1",
      gitlabProjectId: 42,
      gitlabPathNamespace: "platform/apps/source-app",
      composePath: "deploy/custom/compose.yaml",
      watchPaths: ["backend/**", "frontend/**"]
    }
  }
};\n`);

  const config = await loadConfig(cwd);

  assert.equal(config.deploy.source.sourceType, "gitlab");
  assert.equal(config.deploy.source.repository, "https://gitlab.example.test/platform/apps/source-app.git");
  assert.equal(config.deploy.source.branch, "main");
  assert.equal(config.deploy.source.gitlabId, "gitlab-1");
  assert.equal(config.deploy.source.gitlabProjectId, 42);
  assert.equal(config.deploy.source.gitlabPathNamespace, "platform/apps/source-app");
  assert.equal(config.deploy.source.composePath, "deploy/custom/compose.yaml");
  assert.deepEqual(config.deploy.source.watchPaths, ["backend/**", "frontend/**"]);
});
