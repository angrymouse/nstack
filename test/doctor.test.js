import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDoctorReport, doctor } from "../src/doctor.js";
import { normalizeConfig } from "../src/config.js";

test("doctor reports resolved config, files, secrets, tools, and state", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Doctor App", slug: "doctor-app" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "resources.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
export const db = new SQLDatabase("app", {});
function secret(name) { return name; }
export const configured = secret("API_SECRET");
export const missing = secret("MISSING_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=doctor.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/doctor",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=secret-value\n");
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { projectId: "project-1", environmentId: "environment-1", composeId: "compose-1" },
  }));

  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") return Response.json({ json: [] });
    throw new Error(`unexpected fetch ${init.method} ${parsed.pathname}`);
  };
  console.log = (value = "") => output.push(String(value));
  let report;
  try {
    report = await doctor({ cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.app.slug, "doctor-app");
  assert.equal(report.app.domain, "doctor.example.test");
  assert.equal(report.deploy.registry, "ghcr.io/acme/doctor");
  assert.equal(report.deploy.dokployApiKeySet, true);
  assert.equal(report.files.backend, true);
  assert.equal(report.files.frontendDockerfile, true);
  assert.deepEqual(report.secrets.keys, ["API_SECRET"]);
  assert.deepEqual(report.secrets.required, ["API_SECRET", "MISSING_SECRET"]);
  assert.deepEqual(report.secrets.missing, ["MISSING_SECRET"]);
  assert.deepEqual(report.resources.databases, ["app"]);
  assert.equal(report.state.projectId, "project-1");
  assert.equal(report.state.composeId, "compose-1");
  assert.equal(report.remote.dokploy.checked, true);
  assert.equal(report.remote.dokploy.ok, true);
  assert.equal(report.tools.node.ok, true);
  assert.equal(report.ready.render, true);
  assert.equal(report.ready.deploy, false);
  assert.equal(report.checks.find((check) => check.name === "app-secrets").ok, false);
  assert.ok(report.nextSteps.includes("Set missing app runtime secrets: MISSING_SECRET"));
  assert.equal(JSON.parse(output.join("\n")).app.slug, "doctor-app");
});

test("doctor --check sets a nonzero exit code when deploy is not ready", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-check-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Doctor Check", slug: "doctor-check" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const missing = secret("MISSING_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=doctor-check.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/doctor-check",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));

  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") return Response.json({ json: [] });
    throw new Error(`unexpected fetch ${init.method} ${parsed.pathname}`);
  };
  console.log = () => {};
  try {
    const report = await doctor({ cwd, json: true, check: true, skipBuild: true });
    assert.equal(report.ready.deploySkipBuild, false);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test("doctor --check fails when Dokploy API auth is invalid", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-remote-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Remote Check", slug: "remote-check" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=remote-check.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/remote-check",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=bad-key",
    "",
  ].join("\n"));

  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") {
      return new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "invalid API key" }), { status: 401 });
    }
    throw new Error(`unexpected fetch ${init.method} ${parsed.pathname}`);
  };
  console.log = (value = "") => output.push(String(value));
  try {
    const report = await doctor({ cwd, json: true, check: true, skipBuild: true });
    const remoteCheck = report.checks.find((check) => check.name === "dokploy-connection");
    assert.equal(report.remote.dokploy.checked, true);
    assert.equal(report.remote.dokploy.ok, false);
    assert.equal(remoteCheck.ok, false);
    assert.equal(report.ready.deploySkipBuild, false);
    assert.equal(process.exitCode, 1);
    assert.match(report.nextSteps.join("\n"), /Fix Dokploy API access: Dokploy GET \/api\/project\.all failed: 401/);
    assert.equal(JSON.parse(output.join("\n")).remote.dokploy.ok, false);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test("doctor reports invalid build platform before deploy", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-platform-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Platform Check", slug: "platform-check" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=platform.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/platform",
    "NSTACK_PLATFORM=linux/s390x",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));

  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") return Response.json({ json: [] });
    throw new Error(`unexpected fetch ${init.method} ${parsed.pathname}`);
  };
  console.log = () => {};
  try {
    const report = await doctor({ cwd, json: true, check: true });
    const platform = report.checks.find((check) => check.name === "platform");
    assert.equal(report.deploy.platform, "linux/s390x");
    assert.equal(platform.ok, false);
    assert.match(platform.fix, /Unsupported target platform "linux\/s390x"/);
    assert.equal(report.ready.deploy, false);
    assert.equal(report.ready.deploySkipBuild, true);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    process.exitCode = previousExitCode;
  }
});

test("doctor reports missing backend build tool before build", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-backend-build-"));
  const fakeBin = path.join(cwd, "bin");
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Backend Build Tool", slug: "backend-build-tool" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=backend-build.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/backend-build",
    "",
  ].join("\n"));
  writeFileSync(path.join(fakeBin, "encore"), `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "encore v1.0.0"
  exit 0
fi
if [ "$1" = "debug" ]; then
  echo '{"svcs":[],"sql_databases":[],"cache_clusters":[],"pubsub_topics":[],"buckets":[],"pkgs":[],"cron_jobs":[]}'
  exit 0
fi
exit 0
`);
  chmodSync(path.join(fakeBin, "encore"), 0o755);
  writeFileSync(path.join(fakeBin, "docker"), `#!/bin/sh
echo "Docker version 99.0.0"
`);
  chmodSync(path.join(fakeBin, "docker"), 0o755);

  const originalLog = console.log;
  const originalPath = process.env.PATH;
  console.log = () => {};
  process.env.PATH = fakeBin;
  try {
    const report = await doctor({ cwd, json: true, skipRemote: true });
    const backendBuild = report.checks.find((check) => check.name === "backend-build");
    assert.equal(report.tools.encore.ok, true);
    assert.equal(report.tools.docker.ok, true);
    assert.equal(report.tools.backendBuild.ok, false);
    assert.equal(backendBuild.ok, false);
    assert.equal(report.ready.render, true);
    assert.equal(report.ready.build, false);
    assert.ok(report.nextSteps.includes("Install or update Encore so tsbundler-encore is available on PATH. Encore Cloud login is not required."));
  } finally {
    console.log = originalLog;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("doctor blocks deploys when Encore cron endpoints are public", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-doctor-cron-expose-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "backend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Cron Expose", slug: "cron-expose" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=cron-expose.example.test",
    "NSTACK_REPOSITORY=git@git.example.test:acme/cron-expose.git",
    "NSTACK_BRANCH=main",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));

  const config = normalizeConfig({
    app: { name: "Cron Expose", slug: "cron-expose", domain: "cron-expose.example.test" },
    deploy: {
      buildMode: "compose",
      source: { repository: "git@git.example.test:acme/cron-expose.git", branch: "main" },
      provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
    },
  });
  const resources = {
    source: "encore-metadata",
    services: [],
    databases: [],
    caches: [],
    topics: [],
    buckets: [],
    secrets: [],
    crons: [
      {
        name: "public-refresh",
        endpoint: { service: "api", name: "refresh", exposed: true },
      },
    ],
  };

  const report = await createDoctorReport({
    cwd,
    config,
    state: {},
    resources,
    checkRemote: false,
  });

  const cronCheck = report.checks.find((check) => check.name === "cron-endpoints-private");
  assert.equal(cronCheck.ok, false);
  assert.deepEqual(report.resources.exposedCrons, ["public-refresh (api.refresh)"]);
  assert.equal(report.ready.render, false);
  assert.equal(report.ready.deploy, false);
  assert.ok(report.nextSteps.includes("Make Encore cron endpoints private with api({ expose: false }, ...): public-refresh (api.refresh)"));
});
