import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { formatDotEnv, parseDotEnv } from "../src/util.js";

test("env command manages app runtime secrets separately from link settings", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "env-app", slug: "env-app" } };\n`);

  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    await runCli([
      "link",
      "--domain",
      "env.example.test",
      "--registry",
      "ghcr.io/acme/env",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "dummy",
      "--yes",
    ]);
    await runCli(["env", "set", "API_SECRET", "secret-value"]);
    await runCli(["secrets", "set", "SECOND_SECRET", "second-value"]);
    await runCli(["env", "unset", "SECOND_SECRET"]);
  } finally {
    process.chdir(previousCwd);
  }

  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.env"), "utf8");
  const secretsEnv = readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8");

  assert.match(localEnv, /NSTACK_DOMAIN=env\.example\.test/);
  assert.doesNotMatch(localEnv, /API_SECRET|SECOND_SECRET/);
  assert.match(secretsEnv, /API_SECRET=secret-value/);
  assert.doesNotMatch(secretsEnv, /SECOND_SECRET/);
});

test("unlink clears deploy target state but preserves app runtime secrets", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-unlink-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "unlink-app", slug: "unlink-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), "NSTACK_DOMAIN=unlink.example.test\n");
  writeFileSync(path.join(cwd, ".nstack", "state.json"), "{}\n");
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=secret-value\n");

  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    await runCli(["unlink"]);
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(existsSync(path.join(cwd, ".nstack", "local.env")), false);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.json")), false);
  assert.equal(readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8"), "API_SECRET=secret-value\n");
});

test("unlink --json honors --cwd and reports removed files", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-unlink-json-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "unlink-json", slug: "unlink-json" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), "NSTACK_TARGET=staging\n");
  writeFileSync(path.join(cwd, ".nstack", "state.staging.json"), "{}\n");
  writeFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), "API_SECRET=secret-value\n");

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "unlink", "--env", "staging", "--json"]);
    assert.equal(report.target, "staging");
  } finally {
    console.log = originalLog;
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.deepEqual(report.removed, [".nstack/local.staging.env", ".nstack/state.staging.json"]);
  assert.deepEqual(report.preserved, [".nstack/secrets.staging.env"]);
  assert.equal(existsSync(path.join(cwd, ".nstack", "local.staging.env")), false);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.staging.json")), false);
  assert.equal(readFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), "utf8"), "API_SECRET=secret-value\n");
  assert.doesNotMatch(json, /secret-value/);
});

test("env run loads local deploy env and app runtime secrets for a child command", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-run-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "env-run-app", slug: "env-run-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), "NSTACK_DOMAIN=run.example.test\n");
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=secret-value\n");
  const outputFile = path.join(cwd, "env-output.txt");
  const script = [
    "require('node:fs').writeFileSync(",
    "process.argv[1],",
    "[process.env.API_SECRET, process.env.NSTACK_DOMAIN, process.argv.includes('--child-flag')].join(':')",
    ")",
  ].join("");

  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(cwd);
  try {
    await runCli(["env", "run", "--", process.execPath, "-e", script, outputFile, "--child-flag"]);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }

  assert.equal(readFileSync(outputFile, "utf8"), "secret-value:run.example.test:true");
});

test("env command keeps target-specific runtime secrets separate", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-target-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "env-target-app", slug: "env-target-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), "NSTACK_DOMAIN=prod.example.test\n");
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), [
    "NSTACK_DOMAIN=staging.example.test",
    "NSTACK_TARGET=staging",
    "",
  ].join("\n"));
  const outputFile = path.join(cwd, "target-env-output.txt");
  const script = [
    "require('node:fs').writeFileSync(",
    "process.argv[1],",
    "[process.env.API_SECRET, process.env.NSTACK_DOMAIN, process.env.NSTACK_TARGET].join(':')",
    ")",
  ].join("");

  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(cwd);
  try {
    await runCli(["env", "set", "API_SECRET", "prod-secret"]);
    await runCli(["env", "set", "API_SECRET", "staging-secret", "--env", "staging"]);
    await runCli(["env", "run", "--env", "staging", "--", process.execPath, "-e", script, outputFile]);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }

  assert.match(readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8"), /API_SECRET=prod-secret/);
  assert.match(readFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), "utf8"), /API_SECRET=staging-secret/);
  assert.equal(readFileSync(outputFile, "utf8"), "staging-secret:staging.example.test:staging");
});

test("env list --json reports secret names without values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-list-json-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "env-list-app", slug: "env-list-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), "NSTACK_TARGET=staging\n");
  writeFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), [
    "API_SECRET=secret-value",
    "SECOND_SECRET=second-value",
    "",
  ].join("\n"));

  const output = [];
  const originalLog = console.log;
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["env", "list", "--env", "staging", "--json"]);
    assert.equal(report.count, 2);
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.target, "staging");
  assert.equal(report.file, ".nstack/secrets.staging.env");
  assert.deepEqual(report.keys, ["API_SECRET", "SECOND_SECRET"]);
  assert.doesNotMatch(json, /secret-value|second-value/);
});

test("env set and unset --json report mutations without values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-mutation-json-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "env-json-app", slug: "env-json-app" } };\n`);

  const output = [];
  const originalLog = console.log;
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    console.log = (value = "") => output.push(String(value));
    const setReport = await runCli(["env", "set", "API_SECRET", "secret-value", "--json"]);
    assert.equal(setReport.action, "set");
    const unsetReport = await runCli(["env", "unset", "API_SECRET", "--json"]);
    assert.equal(unsetReport.action, "unset");
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }

  const [setJson, unsetJson] = output.map((line) => JSON.parse(line));
  assert.equal(setJson.key, "API_SECRET");
  assert.equal(setJson.existed, false);
  assert.equal(setJson.count, 1);
  assert.deepEqual(setJson.keys, ["API_SECRET"]);
  assert.equal(unsetJson.key, "API_SECRET");
  assert.equal(unsetJson.existed, true);
  assert.equal(unsetJson.count, 0);
  assert.deepEqual(unsetJson.keys, []);
  assert.doesNotMatch(output.join("\n"), /secret-value/);
});

test("env push --stage syncs local Compose env to Dokploy without redeploying", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-push-stage-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Env Push Stage", slug: "env-push-stage" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "resources.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
export const db = new SQLDatabase("app", {});
function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=env-push-stage.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/env-push-stage",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), [
    "API_SECRET=local-api-secret",
    "UNDECLARED_SECRET=local-undeclared-secret",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { composeId: "compose-1" },
    infra: { postgres: { password: "local-postgres-password" } },
  }, null, 2)}\n`);

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    return Response.json({ json: {} });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "env", "push", "--stage", "--all", "--json"]);
    assert.equal(report.mode, "env-push");
    assert.equal(report.env.staged, true);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => call.path), ["/api/compose.saveEnvironment"]);
  assert.match(calls[0].body.env, /NSTACK_POSTGRES_PASSWORD=local-postgres-password/);
  assert.match(calls[0].body.env, /API_SECRET=local-api-secret/);
  assert.match(calls[0].body.env, /UNDECLARED_SECRET=local-undeclared-secret/);

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.deepEqual(report.env.keys, ["API_SECRET", "NSTACK_POSTGRES_PASSWORD", "UNDECLARED_SECRET"]);
  assert.equal(report.state.lastAttempt, null);
  assert.doesNotMatch(json, /local-api-secret|local-undeclared-secret|local-postgres-password/);

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastEnvPush.staged, true);
  assert.deepEqual(state.lastEnvPush.keys, ["API_SECRET", "NSTACK_POSTGRES_PASSWORD", "UNDECLARED_SECRET"]);
});

test("env push redeploys the saved release by default", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-push-redeploy-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Env Push Redeploy", slug: "env-push-redeploy" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=env-push-redeploy.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/env-push-redeploy",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=redeploy-secret\n");
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: {
      commit: "releasecommit",
      tag: "release-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
  }, null, 2)}\n`);

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    return Response.json({ json: {} });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "env", "push", "--skip-status", "--json"]);
    assert.equal(report.mode, "env-push");
    assert.equal(report.release.tag, "release-tag");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => call.path), ["/api/compose.saveEnvironment", "/api/compose.redeploy"]);
  assert.equal(calls[1].body.composeId, "compose-1");
  assert.match(calls[1].body.title, /nstack retry release-tag/);

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.state.lastAttempt.status, "verified");
  assert.equal(report.state.lastAttempt.envPush, true);
  assert.equal(report.state.lastAttempt.checks.public, "passed");
  assert.equal(report.state.lastAttempt.checks.dokploy, "skipped");
  assert.doesNotMatch(json, /redeploy-secret/);
});

test("env push refuses to invent missing infrastructure secrets", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-push-missing-infra-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Env Missing Infra", slug: "env-missing-infra" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
export const db = new SQLDatabase("app", {});
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=env-missing-infra.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/env-missing-infra",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { composeId: "compose-1" },
  }, null, 2)}\n`);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("env push should fail before Dokploy calls when infra state is missing");
  };

  try {
    await assert.rejects(
      runCli(["--cwd", cwd, "env", "push", "--stage"]),
      /Missing local infrastructure state for NSTACK_POSTGRES_PASSWORD/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dotenv formatting round-trips quoted and escaped secret values", () => {
  const parsed = parseDotEnv(formatDotEnv({
    PLAIN: "simple-value",
    QUOTED: "value with spaces",
    MULTILINE: "line one\nline two",
  }));

  assert.deepEqual(parsed, {
    MULTILINE: "line one\nline two",
    PLAIN: "simple-value",
    QUOTED: "value with spaces",
  });
});
