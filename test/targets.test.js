import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { parseDotEnv, readText } from "../src/util.js";

test("targets lists local deploy targets without secret values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-targets-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=prod.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/prod",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=prod-api-key",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: {
      projectId: "project-prod",
      environmentId: "environment-prod",
      composeId: "compose-prod",
      schedules: { refresh: "schedule-prod" },
    },
    lastRelease: {
      commit: "prodcommit",
      tag: "prod-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=prod-secret\n");
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), [
    "NSTACK_TARGET=staging",
    "NSTACK_DOMAIN=staging.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/staging",
    "DOKPLOY_URL=https://dokploy-staging.example.test",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.staging.json"), `${JSON.stringify({
    dokploy: {
      environmentId: "environment-staging",
      composeId: "compose-staging",
    },
    lastAttempt: {
      commit: "stagingcommit",
      tag: "staging-tag",
      builtAt: "2026-06-18T00:01:00.000Z",
      status: "triggered",
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), "API_SECRET=staging-secret\nSECOND_SECRET=second-secret\n");

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "targets", "--json"]);
    assert.equal(report.current, "prod");
  } finally {
    console.log = originalLog;
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.deepEqual(report.targets.map((target) => target.name), ["prod", "staging"]);
  assert.equal(report.targets[0].domain, "prod.example.test");
  assert.equal(report.targets[0].linked, true);
  assert.equal(report.targets[0].state.composeId, "compose-prod");
  assert.equal(report.targets[0].state.scheduleCount, 1);
  assert.equal(report.targets[0].release.tag, "prod-tag");
  assert.equal(report.targets[0].dokployApiKeySet, true);
  assert.deepEqual(report.targets[0].secrets.keys, ["API_SECRET"]);
  assert.equal(report.targets[1].linked, false);
  assert.equal(report.targets[1].state.composeId, "compose-staging");
  assert.deepEqual(report.targets[1].secrets.keys, ["API_SECRET", "SECOND_SECRET"]);
  assert.doesNotMatch(json, /prod-secret|staging-secret|second-secret|prod-api-key/);
});

test("targets marks the selected target in text output", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-targets-text-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, ".nstack", "local.env"), "NSTACK_DOMAIN=prod.example.test\n");
  writeFileSync(path.join(cwd, ".nstack", "local.preview.env"), [
    "NSTACK_TARGET=preview",
    "NSTACK_DOMAIN=preview.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=preview-api-key",
    "",
  ].join("\n"));

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "target", "--env", "preview"]);
    assert.equal(report.current, "preview");
  } finally {
    console.log = originalLog;
  }

  assert.ok(output.includes("targets:"));
  assert.ok(output.some((line) => line.startsWith("* preview  https://preview.example.test  linked")));
  assert.ok(output.some((line) => line.startsWith("  prod  https://prod.example.test  unlinked")));
  assert.doesNotMatch(output.join("\n"), /preview-api-key/);
});

test("target create clones deploy settings into an independent Dokploy environment", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-target-create-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_TARGET=prod",
    "NSTACK_DOMAIN=prod.example.test",
    "NSTACK_BUILD_MODE=compose",
    "NSTACK_REPOSITORY=https://github.com/acme/app.git",
    "NSTACK_BRANCH=main",
    "NSTACK_SOURCE_TYPE=github",
    "NSTACK_GITHUB_ID=github-provider",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=prod-api-key",
    "DOKPLOY_PROJECT=acme-app",
    "DOKPLOY_ENVIRONMENT=production",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=prod-secret\n");
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { projectId: "project-prod", environmentId: "environment-prod" },
  }, null, 2)}\n`);

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "--cwd", cwd,
      "target", "create", "staging",
      "--domain", "staging.example.test",
      "--branch", "staging",
      "--json",
    ]);
    assert.equal(report.target, "staging");
    assert.equal(report.environment, "staging");
    assert.equal(report.branch, "staging");
    assert.equal(report.dokployApiKeySet, true);
  } finally {
    console.log = originalLog;
  }

  const env = parseDotEnv(readText(path.join(cwd, ".nstack", "local.staging.env"), ""));
  assert.equal(env.NSTACK_TARGET, "staging");
  assert.equal(env.NSTACK_DOMAIN, "staging.example.test");
  assert.equal(env.NSTACK_BUILD_MODE, "compose");
  assert.equal(env.NSTACK_REPOSITORY, "https://github.com/acme/app.git");
  assert.equal(env.NSTACK_BRANCH, "staging");
  assert.equal(env.NSTACK_SOURCE_TYPE, "github");
  assert.equal(env.NSTACK_GITHUB_ID, "github-provider");
  assert.equal(env.DOKPLOY_URL, "https://dokploy.example.test");
  assert.equal(env.DOKPLOY_API_KEY, "prod-api-key");
  assert.equal(env.DOKPLOY_PROJECT, "acme-app");
  assert.equal(env.DOKPLOY_ENVIRONMENT, "staging");
  assert.equal(existsSync(path.join(cwd, ".nstack", "secrets.staging.env")), false);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.staging.json")), false);
  assert.doesNotMatch(output.join("\n"), /prod-api-key|prod-secret/);
});

test("target create requires an explicit domain", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-target-create-domain-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=prod.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=prod-api-key",
    "",
  ].join("\n"));

  await assert.rejects(
    () => runCli(["--cwd", cwd, "target", "create", "preview"]),
    /Target domain is required/,
  );
});

test("target create refuses to overwrite without force", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-target-create-force-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=prod.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=prod-api-key",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), [
    "NSTACK_TARGET=staging",
    "NSTACK_DOMAIN=old-staging.example.test",
    "",
  ].join("\n"));

  await assert.rejects(
    () => runCli(["--cwd", cwd, "target", "create", "staging", "--domain", "new-staging.example.test"]),
    /Target staging already exists/,
  );

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    await runCli(["--cwd", cwd, "target", "create", "staging", "--domain", "new-staging.example.test", "--force", "--json"]);
  } finally {
    console.log = originalLog;
  }
  const env = parseDotEnv(readText(path.join(cwd, ".nstack", "local.staging.env"), ""));
  assert.equal(env.NSTACK_DOMAIN, "new-staging.example.test");
});
