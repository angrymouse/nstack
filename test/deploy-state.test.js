import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deploy, redeploy, rollback, waitForDeployment } from "../src/deploy.js";

test("render does not require Dokploy credentials", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-render-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Render Test", slug: "render-test" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  deploy: { provider: { type: "dokploy" } },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
import { Bucket } from "encore.dev/storage/objects";
export const db = new SQLDatabase("app", {});
export const uploads = new Bucket("uploads", {});
`);
  writeFileSync(path.join(cwd, "backend", "api", "gateway.ts"), `import { Gateway } from "encore.dev/api";
export const gateway = new Gateway({});
`);

  const envKeys = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_DOMAIN", "NSTACK_REGISTRY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    await deploy({
      cwd,
      renderOnly: true,
      yes: true,
      domain: "example.test",
      registry: "ghcr.io/acme/render-test",
    });
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.env"), "utf8");
  const infra = JSON.parse(readFileSync(path.join(cwd, "deploy", "nstack", "encore.infra.json"), "utf8"));
  assert.match(localEnv, /NSTACK_DOMAIN=example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/render-test/);
  assert.doesNotMatch(localEnv, /DOKPLOY_URL/);
  assert.doesNotMatch(localEnv, /DOKPLOY_API_KEY/);
  assert.deepEqual(infra.hosted_services, ["api"]);
  assert.deepEqual(infra.hosted_gateways, ["api-gateway"]);
  assert.deepEqual(Object.keys(infra.sql_servers[0].databases), ["app"]);
  assert.equal(infra.sql_servers[0].databases.app.name, "app");
});

test("render does not require or persist app runtime secrets", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-secret-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Secret Test", slug: "secret-test" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);

  const envKeys = ["API_SECRET", "NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.API_SECRET = "super-secret";
  for (const key of envKeys.filter((key) => key !== "API_SECRET")) delete process.env[key];
  try {
    await deploy({
      cwd,
      renderOnly: true,
      yes: true,
      domain: "example.test",
      registry: "ghcr.io/acme/secret-test",
    });
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.env"), "utf8");
  assert.doesNotMatch(localEnv, /API_SECRET/);
  assert.equal(existsSync(path.join(cwd, ".nstack", "secrets.env")), false);
});

test("render --json prints a machine readable plan without secret values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-render-json-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Render Json", slug: "render-json" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);

  const envKeys = ["API_SECRET", "NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.API_SECRET = "render-secret-value";
  for (const key of envKeys.filter((key) => key !== "API_SECRET")) delete process.env[key];
  const originalLog = console.log;
  const output = [];
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await deploy({
      cwd,
      renderOnly: true,
      json: true,
      yes: true,
      domain: "render-json.example.test",
      registry: "ghcr.io/acme/render-json",
    });
    assert.equal(report.mode, "render");
  } finally {
    console.log = originalLog;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.mode, "render");
  assert.equal(report.app.url, "https://render-json.example.test");
  assert.deepEqual(report.resources.secrets, ["API_SECRET"]);
  assert.equal(existsSync(report.artifacts.infra), true);
  assert.equal(existsSync(report.artifacts.compose), true);
  assert.doesNotMatch(json, /render-secret-value|nstack plan/);
});

test("build renders and pushes images without Dokploy credentials or state writes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-build-"));
  const fakeBin = path.join(cwd, "bin");
  const fakeEncoreInstall = path.join(cwd, "encore-install");
  const callsFile = path.join(cwd, "tool-calls.jsonl");
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(path.join(fakeEncoreInstall, "runtimes", "js", "encore.dev"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Build App", slug: "build-app" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "backend", "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "encore.dev": "^1.57.6" },
  }));
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(fakeEncoreInstall, "runtimes", "js", "encore-runtime.node"), "runtime");
  writeFileSync(path.join(fakeEncoreInstall, "runtimes", "js", "encore.dev", "package.json"), "{}\n");

  writeFileSync(path.join(fakeBin, "encore"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "encore", args }) + "\\n");
if (args[0] === "version") {
  console.log("encore v1.0.0");
  process.exit(0);
}
if (args[0] === "debug") {
  console.log(JSON.stringify({ svcs: [], sql_databases: [], cache_clusters: [], pubsub_topics: [], buckets: [], pkgs: [], cron_jobs: [] }));
  process.exit(0);
}
if (args[0] === "gen" && args[1] === "wrappers") {
  const file = path.join(process.cwd(), "encore.gen/internal/entrypoints/combined/main.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "console.log('entry');\\n");
  process.exit(0);
}
if (args[0] === "test" && args[1] === "--prepare") {
  console.log("ENCORE_APP_META=" + Buffer.from("app-meta").toString("base64"));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "encore"), 0o755);

  writeFileSync(path.join(fakeBin, "tsbundler-encore"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "tsbundler-encore", args }) + "\\n");
const outdirArg = args.find((arg) => arg.startsWith("--outdir="));
const outdir = outdirArg ? outdirArg.slice("--outdir=".length) : ".encore/nstack/bundle";
const file = path.join(process.cwd(), outdir, "combined/main.mjs");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, "console.log('bundle');\\n");
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "tsbundler-encore"), 0o755);

  writeFileSync(path.join(fakeBin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "docker", args }) + "\\n");
if (args[0] === "--version") console.log("Docker version 99.0.0");
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "docker"), 0o755);

  const envKeys = [
    "NSTACK_DOMAIN",
    "NSTACK_REGISTRY",
    "DOKPLOY_URL",
    "DOKPLOY_API_KEY",
    "ENCORE_INSTALL",
    "NSTACK_FAKE_CALLS",
    "NSTACK_IMAGE_TAG",
    "PATH",
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "build.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/build-app";
  process.env.ENCORE_INSTALL = fakeEncoreInstall;
  process.env.NSTACK_FAKE_CALLS = callsFile;
  process.env.NSTACK_IMAGE_TAG = "build-tag";
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
  delete process.env.DOKPLOY_URL;
  delete process.env.DOKPLOY_API_KEY;

  const output = [];
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  try {
    console.log = (value = "") => output.push(String(value));
    globalThis.fetch = async () => {
      throw new Error("nstack build should not call Dokploy");
    };
    const report = await deploy({ cwd, buildOnly: true, json: true, yes: true });
    assert.equal(report.mode, "build");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  const manifest = JSON.parse(readFileSync(path.join(cwd, "deploy", "nstack", "release.json"), "utf8"));
  const calls = readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.env"), "utf8");

  assert.equal(report.mode, "build");
  assert.equal(report.app.url, "https://build.example.test");
  assert.equal(report.images.backend, "ghcr.io/acme/build-app/backend:build-tag");
  assert.equal(report.images.frontend, "ghcr.io/acme/build-app/frontend:build-tag");
  assert.ok(report.timings.total_ms >= 0);
  assert.deepEqual(report.timings.steps.map((step) => step.name), [
    "backend: encore wrappers",
    "backend: bundle",
    "backend: prepare app metadata",
    "backend: resolve runtime binary",
    "backend: resolve runtime package",
    "backend: stage image files",
    "backend: docker build",
    "backend: docker push",
    "frontend: docker build",
    "frontend: docker push",
  ]);
  assert.equal(existsSync(report.artifacts.infra), true);
  assert.equal(existsSync(report.artifacts.compose), true);
  assert.equal(existsSync(report.artifacts.release), true);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.json")), false);
  assert.equal(manifest.schema, "nstack.release.v1");
  assert.equal(manifest.release.tag, "build-tag");
  assert.equal(manifest.images.backend, report.images.backend);
  assert.equal(manifest.deploy.registry, "ghcr.io/acme/build-app");
  assert.match(localEnv, /NSTACK_DOMAIN=build\.example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/build-app/);
  assert.doesNotMatch(localEnv, /DOKPLOY_URL|DOKPLOY_API_KEY/);
  assert.ok(calls.some((call) => call.cmd === "encore" && call.args.join(" ") === "gen wrappers"));
  assert.ok(calls.some((call) => call.cmd === "encore" && call.args.join(" ") === "debug meta -f proto"));
  assert.ok(calls.some((call) => call.cmd === "tsbundler-encore" && call.args.includes("--bundle")));
  assert.ok(calls.some((call) => call.cmd === "docker" && call.args[0] === "build" && call.args.includes(path.join(cwd, "backend", ".encore", "nstack", "image"))));
  assert.ok(calls.some((call) => call.cmd === "docker" && call.args[0] === "push" && call.args[1] === report.images.backend));
  assert.ok(calls.some((call) => call.cmd === "docker" && call.args[0] === "push" && call.args[1] === report.images.frontend));
  assert.doesNotMatch(json, /Docker version|encore v1\.0\.0|Built build-app/);
});

test("deploy --prebuilt uses the build release manifest", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-prebuilt-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "deploy", "nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Prebuilt App", slug: "prebuilt-app" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "deploy", "nstack", "release.json"), `${JSON.stringify({
    schema: "nstack.release.v1",
    app: { slug: "prebuilt-app", domain: "prebuilt.example.test" },
    deploy: { target: "prod", registry: "ghcr.io/acme/prebuilt-app", platform: "linux/amd64" },
    release: { commit: "builtcommit", tag: "built-tag", builtAt: "2026-06-18T00:00:00.000Z" },
    images: {
      backend: "ghcr.io/acme/prebuilt-app/backend:built-tag",
      frontend: "ghcr.io/acme/prebuilt-app/frontend:built-tag",
    },
    resources: { source: "source-scan", databases: [], caches: [], topics: [], buckets: [], crons: [], secrets: [] },
    artifacts: {
      infra: "deploy/nstack/encore.infra.json",
      compose: "deploy/nstack/compose.dokploy.yaml",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_IMAGE_TAG", "NSTACK_PLATFORM", "PROD_PLATFORM"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "prebuilt.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/prebuilt-app";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  process.env.NSTACK_IMAGE_TAG = "wrong-tag";
  delete process.env.NSTACK_PLATFORM;
  delete process.env.PROD_PLATFORM;

  const calls = [];
  let composeFile = "";
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, method: init.method, body });
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    if (endpoint === "compose.create") composeFile = body.composeFile;
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    const report = await deploy({
      cwd,
      prebuilt: true,
      skipStatus: true,
      yes: true,
    });
    assert.equal(report.release.tag, "built-tag");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.match(composeFile, /ghcr\.io\/acme\/prebuilt-app\/backend:built-tag/);
  assert.match(composeFile, /ghcr\.io\/acme\/prebuilt-app\/frontend:built-tag/);
  assert.doesNotMatch(composeFile, /wrong-tag/);
  assert.equal(state.lastRelease.tag, "built-tag");
  assert.equal(state.lastAttempt.checks.public, "passed");
  assert.equal(state.lastAttempt.checks.dokploy, "skipped");
  assert.equal(calls.some((call) => call.endpoint === "compose.deploy"), true);
});

test("deploy --prebuilt fails when the release manifest is missing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-prebuilt-missing-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Missing Manifest", slug: "missing-manifest" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "missing.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/missing";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  try {
    await assert.rejects(
      deploy({ cwd, prebuilt: true, yes: true }),
      /deploy --prebuilt requires deploy\/nstack\/release\.json/,
    );
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("deploy --prebuilt refuses a stale release manifest before Dokploy calls", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-prebuilt-stale-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "deploy", "nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Stale Manifest", slug: "stale-manifest" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "deploy", "nstack", "release.json"), `${JSON.stringify({
    schema: "nstack.release.v1",
    app: { slug: "stale-manifest", domain: "old.example.test" },
    deploy: { target: "prod", registry: "ghcr.io/acme/stale", platform: "linux/amd64" },
    release: { commit: "oldcommit", tag: "old-tag", builtAt: "2026-06-18T00:00:00.000Z" },
    images: {
      backend: "ghcr.io/acme/stale/backend:old-tag",
      frontend: "ghcr.io/acme/stale/frontend:old-tag",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_PLATFORM", "PROD_PLATFORM"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.NSTACK_DOMAIN = "new.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/stale";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  delete process.env.NSTACK_PLATFORM;
  delete process.env.PROD_PLATFORM;
  globalThis.fetch = async () => {
    throw new Error("stale prebuilt manifest should fail before Dokploy calls");
  };
  try {
    await assert.rejects(
      deploy({ cwd, prebuilt: true, yes: true }),
      /domain is old\.example\.test, expected new\.example\.test/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("deploy --skip-build ignores release manifests unless --prebuilt is used", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-skip-build-manifest-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "deploy", "nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Skip Manifest", slug: "skip-manifest" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "deploy", "nstack", "release.json"), `${JSON.stringify({
    schema: "nstack.release.v1",
    app: { slug: "skip-manifest", domain: "skip-manifest.example.test" },
    deploy: { target: "prod", registry: "ghcr.io/acme/skip-manifest", platform: "linux/amd64" },
    release: { commit: "oldcommit", tag: "old-tag", builtAt: "2026-06-18T00:00:00.000Z" },
    images: {
      backend: "ghcr.io/acme/skip-manifest/backend:old-tag",
      frontend: "ghcr.io/acme/skip-manifest/frontend:old-tag",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_IMAGE_TAG", "NSTACK_PLATFORM", "PROD_PLATFORM"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "skip-manifest.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/skip-manifest";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  process.env.NSTACK_IMAGE_TAG = "external-tag";
  delete process.env.NSTACK_PLATFORM;
  delete process.env.PROD_PLATFORM;

  let composeFile = "";
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    if (endpoint === "compose.create") composeFile = body.composeFile;
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    const report = await deploy({
      cwd,
      skipBuild: true,
      skipVerify: true,
      skipStatus: true,
      yes: true,
    });
    assert.equal(report.release.tag, "external-tag");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.match(composeFile, /ghcr\.io\/acme\/skip-manifest\/backend:external-tag/);
  assert.match(composeFile, /ghcr\.io\/acme\/skip-manifest\/frontend:external-tag/);
  assert.doesNotMatch(composeFile, /old-tag/);
});

test("deploy persists generated infra state before later Dokploy failures", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-state-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "State Test", slug: "state-test" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  deploy: { provider: { type: "dokploy" } },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
import { Bucket } from "encore.dev/storage/objects";
export const db = new SQLDatabase("app", {});
export const uploads = new Bucket("uploads", {});
`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/state-test";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint.endsWith(".search") || endpoint === "domain.byComposeId")) {
      if (endpoint === "domain.byComposeId") {
        return new Response(JSON.stringify({ error: "domain failure" }), { status: 500 });
      }
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "postgres.create": { postgresId: "postgres-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        skipBuild: true,
        skipVerify: true,
        statusTimeoutMs: 1,
        statusIntervalMs: 1,
        yes: true,
      }),
      /domain\.byComposeId.*failed: 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.dokploy.projectId, "project-1");
  assert.equal(state.dokploy.environmentId, "environment-1");
  assert.equal(state.dokploy.postgresId, "postgres-1");
  assert.equal(state.dokploy.composeId, "compose-1");
  assert.equal(state.infra.postgres.user, "nstack");
  assert.match(state.infra.postgres.password, /^[A-Za-z0-9_-]+$/);
  assert.match(state.infra.objectStorage.accessKey, /^[A-Za-z0-9_-]+$/);
  assert.match(state.infra.objectStorage.secretKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(state.infra.objectStorage.endpoint, "http://state-test-rustfs:9000");
  assert.equal(state.lastRelease, undefined);
  assert.ok(calls.includes("domain.byComposeId"));
});

test("deploy persists generated infra state in the selected target state file", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-target-state-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Target State", slug: "target-state" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  deploy: { provider: { type: "dokploy" } },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
export const db = new SQLDatabase("app", {});
`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_TARGET"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "staging.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/target-state";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  delete process.env.NSTACK_TARGET;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint.endsWith(".search") || endpoint === "domain.byComposeId")) {
      if (endpoint === "domain.byComposeId") {
        return new Response(JSON.stringify({ error: "domain failure" }), { status: 500 });
      }
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "postgres.create": { postgresId: "postgres-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        target: "staging",
        skipBuild: true,
        skipVerify: true,
        yes: true,
      }),
      /domain\.byComposeId.*failed: 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.staging.env"), "utf8");
  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.staging.json"), "utf8"));
  assert.match(localEnv, /NSTACK_TARGET=staging/);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.json")), false);
  assert.equal(state.dokploy.projectId, "project-1");
  assert.equal(state.dokploy.environmentId, "environment-1");
  assert.equal(state.dokploy.postgresId, "postgres-1");
  assert.equal(state.dokploy.composeId, "compose-1");
  assert.match(state.infra.postgres.password, /^[A-Za-z0-9_-]+$/);
  assert.equal(state.lastRelease, undefined);
});

test("deploy refuses existing Dokploy database when local infra password is missing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-existing-db-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Existing DB", slug: "existing-db" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  deploy: { provider: { type: "dokploy" } },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
export const db = new SQLDatabase("app", {});
`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "existing-db.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/existing-db";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    if (init.method === "GET" && endpoint === "project.all") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "environment.byProjectId") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "postgres.search") {
      return Response.json({ json: [{ postgresId: "postgres-1", name: "existing-db-postgres" }] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        skipBuild: true,
        skipVerify: true,
        yes: true,
      }),
      (error) => {
        assert.match(error.message, /Existing Dokploy Postgres existing-db-postgres/);
        assert.match(error.message, /nstack pull/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.dokploy.projectId, "project-1");
  assert.equal(state.dokploy.environmentId, "environment-1");
  assert.equal(state.infra?.postgres?.password, undefined);
});

test("deploy can add first object storage bucket to an existing Compose app", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-existing-bucket-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Existing Bucket", slug: "existing-bucket" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  deploy: { provider: { type: "dokploy" } },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "bucket.ts"), `import { Bucket } from "encore.dev/storage/objects";
export const uploads = new Bucket("uploads", {});
`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
  }));

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "existing-bucket.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/existing-bucket";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  let savedEnv = "";
  let updatedCompose = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "GET") {
      if (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "domain.byComposeId" || endpoint === "schedule.list") {
        return Response.json({ json: [] });
      }
      if (endpoint === "settings.getIp" || endpoint === "server.publicIp") {
        return Response.json({ json: { ip: "203.0.113.10" } });
      }
      if (endpoint === "compose.one") {
        return Response.json({ json: { composeId: "compose-1", env: "API_SECRET=existing\n" } });
      }
      return Response.json({ json: [] });
    }
    if (endpoint === "compose.update") updatedCompose = body.composeFile || updatedCompose;
    if (endpoint === "compose.saveEnvironment") savedEnv = body.env;
    if (endpoint === "domain.validateDomain") return Response.json({ json: { isValid: true, resolvedIp: "203.0.113.10" } });
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "domain.create": { domainId: "domain-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await deploy({
      cwd,
      skipBuild: true,
      skipVerify: true,
      skipStatus: true,
      noWait: true,
      yes: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.dokploy.composeId, "compose-1");
  assert.match(state.infra.objectStorage.accessKey, /^[A-Za-z0-9_-]+$/);
  assert.match(state.infra.objectStorage.secretKey, /^[A-Za-z0-9_-]+$/);
  assert.match(savedEnv, /NSTACK_MINIO_ACCESS_KEY=/);
  assert.match(savedEnv, /NSTACK_MINIO_SECRET_KEY=/);
  assert.match(updatedCompose, /rustfs\/rustfs:latest/);
});

test("render preflight reports missing backend without raw filesystem errors", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-render-preflight-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Render Preflight", slug: "render-preflight" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
};\n`);

  await assert.rejects(
    deploy({
      cwd,
      renderOnly: true,
      yes: true,
      domain: "example.test",
      registry: "ghcr.io/acme/render-preflight",
    }),
    (error) => {
      assert.match(error.message, /nstack render preflight failed/);
      assert.match(error.message, /Create the configured backend directory/);
      assert.doesNotMatch(error.message, /ENOENT/);
      return true;
    },
  );
});

test("deploy preflight fails before build or Dokploy calls when build inputs are missing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-preflight-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Deploy Preflight", slug: "deploy-preflight" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/deploy-preflight";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Dokploy should not be called before deploy preflight passes");
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        skipVerify: true,
        yes: true,
      }),
      (error) => {
        assert.match(error.message, /nstack deploy preflight failed/);
        assert.match(error.message, /Create the configured frontend directory/);
        assert.match(error.message, /Create the frontend Dockerfile/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("deploy preflight checks Dokploy auth before provisioning", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-auth-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Deploy Auth", slug: "deploy-auth" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "deploy-auth.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/deploy-auth";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "bad-key";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (init.method === "GET" && endpoint === "project.all") {
      return new Response(JSON.stringify({ code: "FORBIDDEN", message: "bad key" }), { status: 403 });
    }
    return Response.json({ json: {} });
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        skipBuild: true,
        skipVerify: true,
        yes: true,
      }),
      (error) => {
        assert.match(error.message, /nstack deploy preflight failed/);
        assert.match(error.message, /Fix Dokploy API access/);
        assert.match(error.message, /project\.all failed: 403/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.deepEqual(calls, ["project.all"]);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.json")), false);
  assert.equal(existsSync(path.join(cwd, ".nstack", "secrets.env")), false);
});

test("deploy configures Gitea source-backed Compose apps for push deployments", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-source-push-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Source Push", slug: "source-push" },
  deploy: {
    buildMode: "compose",
    source: {
      repository: "git@git.example.test:acme/source-push.git",
      branch: "feature/push-deploy",
      giteaId: "gitea-explicit",
      composePath: "deploy/custom/compose.yaml",
      watchPaths: ["backend/**", "frontend/**"]
    }
  },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "backend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");

  const envKeys = ["NSTACK_DOMAIN", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "source-push.example.test";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, method: init.method || "GET", body });
    if ((init.method || "GET") === "GET") {
      if (endpoint === "gitProvider.getAll") {
        return Response.json({
          json: [
            {
              providerType: "gitea",
              gitea: {
                giteaId: "gitea-explicit",
                giteaUrl: "https://git.example.test",
                isConfigured: false,
              },
            },
          ],
        });
      }
      if (endpoint === "gitea.giteaProviders") return Response.json({ json: [{ giteaId: "gitea-explicit" }] });
      if (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId" || endpoint === "schedule.list") {
        return Response.json({ json: [] });
      }
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
      "domain.create": { domainId: "domain-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await deploy({
      cwd,
      noWait: true,
      skipVerify: true,
      skipStatus: true,
      yes: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const update = calls.find((call) => call.endpoint === "compose.update");
  assert.equal(update.body.sourceType, "gitea");
  assert.equal(update.body.giteaId, "gitea-explicit");
  assert.equal(update.body.giteaOwner, "acme");
  assert.equal(update.body.giteaRepository, "source-push");
  assert.equal(update.body.giteaBranch, "feature/push-deploy");
  assert.equal(update.body.composePath, "deploy/custom/compose.yaml");
  assert.equal(update.body.autoDeploy, true);
  assert.equal(update.body.triggerType, "push");
  assert.deepEqual(update.body.watchPaths, ["backend/**", "frontend/**"]);

  const save = calls.find((call) => call.endpoint === "compose.saveEnvironment");
  const env = Object.fromEntries(save.body.env.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(env.NSTACK_BUILD_CONTEXT, "../..");
  assert.equal(env.NSTACK_GIT_COMMIT, "acme/source-push@feature/push-deploy");
  assert.equal(env.NSTACK_IMAGE_TAG, "source-feature-push-deploy");
});

test("deploy passes target platform to backend and frontend image builds", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-platform-build-"));
  const fakeBin = path.join(cwd, "bin");
  const fakeHome = path.join(cwd, "home");
  const fakeEncoreInstall = path.join(cwd, "encore-install");
  const callsFile = path.join(cwd, "tool-calls.jsonl");
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(path.join(fakeEncoreInstall, "runtimes", "js", "encore.dev"), { recursive: true });
  mkdirSync(path.join(fakeHome, ".cache", "encore", "cache", "bin", "v1.57.6", "linux", "arm64"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Platform Build", slug: "platform-build" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, "backend", "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "encore.dev": "^1.57.6" },
  }));
  writeFileSync(path.join(cwd, "frontend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(fakeEncoreInstall, "runtimes", "js", "encore.dev", "package.json"), "{}\n");
  writeFileSync(path.join(fakeHome, ".cache", "encore", "cache", "bin", "v1.57.6", "linux", "arm64", "encore-runtime.node"), "runtime");

  writeFileSync(path.join(fakeBin, "encore"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "encore", args }) + "\\n");
if (args[0] === "version") {
  console.log("encore v1.0.0");
  process.exit(0);
}
if (args[0] === "debug") {
  console.log(JSON.stringify({ svcs: [], sql_databases: [], cache_clusters: [], pubsub_topics: [], buckets: [], pkgs: [], cron_jobs: [] }));
  process.exit(0);
}
if (args[0] === "gen" && args[1] === "wrappers") {
  const file = path.join(process.cwd(), "encore.gen/internal/entrypoints/combined/main.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "console.log('entry');\\n");
  process.exit(0);
}
if (args[0] === "test" && args[1] === "--prepare") {
  console.log("ENCORE_APP_META=" + Buffer.from("app-meta").toString("base64"));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "encore"), 0o755);

  writeFileSync(path.join(fakeBin, "tsbundler-encore"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "tsbundler-encore", args }) + "\\n");
const outdirArg = args.find((arg) => arg.startsWith("--outdir="));
const outdir = outdirArg ? outdirArg.slice("--outdir=".length) : ".encore/nstack/bundle";
const file = path.join(process.cwd(), outdir, "combined/main.mjs");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, "console.log('bundle');\\n");
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "tsbundler-encore"), 0o755);

  writeFileSync(path.join(fakeBin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NSTACK_FAKE_CALLS, JSON.stringify({ cmd: "docker", args }) + "\\n");
if (args[0] === "--version") {
  console.log("Docker version 99.0.0");
}
process.exit(0);
`);
  chmodSync(path.join(fakeBin, "docker"), 0o755);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "ENCORE_INSTALL", "HOME", "NSTACK_FAKE_CALLS", "PATH"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "platform-build.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/platform-build";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  process.env.ENCORE_INSTALL = fakeEncoreInstall;
  process.env.HOME = fakeHome;
  process.env.NSTACK_FAKE_CALLS = callsFile;
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId" || endpoint === "schedule.list")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    await deploy({
      cwd,
      platform: "arm64",
      skipVerify: true,
      skipStatus: true,
      yes: true,
    });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const calls = readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const dockerBuilds = calls.filter((call) => call.cmd === "docker" && call.args[0] === "build");
  const backendBuild = dockerBuilds.find((call) => call.args.includes("ghcr.io/acme/platform-build/backend:local"));
  const frontendBuild = dockerBuilds.find((call) => call.args.includes("ghcr.io/acme/platform-build/frontend:local"));
  const localEnv = readFileSync(path.join(cwd, ".nstack", "local.env"), "utf8");

  assert.deepEqual(backendBuild.args.slice(0, 4), ["build", "--platform", "linux/arm64", "-t"]);
  assert.deepEqual(frontendBuild.args.slice(0, 4), ["build", "--platform", "linux/arm64", "-t"]);
  assert.match(localEnv, /NSTACK_PLATFORM=linux\/arm64/);
});

test("deploy --json prints a verified deployment report without secret values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-json-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Deploy Json", slug: "deploy-json" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=json-secret-value\n");

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "deploy-json.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/deploy-json";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId" || endpoint === "schedule.list")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await deploy({
      cwd,
      json: true,
      skipBuild: true,
      skipStatus: true,
      yes: true,
    });
    assert.equal(report.mode, "deploy");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.mode, "deploy");
  assert.equal(report.app.url, "https://deploy-json.example.test");
  assert.equal(report.state.projectId, "project-1");
  assert.equal(report.state.lastRelease.tag, "local");
  assert.equal(report.state.lastAttempt.status, "verified");
  assert.equal(report.state.lastAttempt.checks.public, "passed");
  assert.equal(report.state.lastAttempt.checks.dokploy, "skipped");
  assert.deepEqual(report.resources.secrets, ["API_SECRET"]);
  assert.equal(calls.includes("settings.updateDockerCleanup"), true);
  assert.equal(calls.includes("settings.cleanUnusedImages"), false);
  assert.doesNotMatch(json, /json-secret-value|Deployed deploy-json|Post-deploy status/);
});

test("deploy --no-wait records a triggered attempt without promoting lastRelease", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-no-wait-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "No Wait", slug: "no-wait" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [{ name: "frontend", path: "/", expectStatus: 200 }] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "no-wait.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/no-wait";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== "dokploy.example.test") {
      throw new Error("deploy --no-wait should not run public verification");
    }
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId" || endpoint === "schedule.list")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await deploy({
      cwd,
      noWait: true,
      skipBuild: true,
      yes: true,
    });
    assert.equal(report.state.lastRelease, null);
    assert.equal(report.state.lastAttempt.status, "triggered");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.ok(calls.includes("compose.deploy"));
  assert.equal(calls.includes("compose.one"), false);
  assert.equal(output[0], "Deployment triggered for no-wait: https://no-wait.example.test");

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease, undefined);
  assert.equal(state.lastAttempt.status, "triggered");
  assert.equal(state.lastAttempt.verifiedAt, undefined);
});

test("deploy with public verification skipped does not promote lastRelease", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-unverified-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Unverified Deploy", slug: "unverified-deploy" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "unverified.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/unverified";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await deploy({
      cwd,
      skipBuild: true,
      skipVerify: true,
      skipStatus: true,
      json: true,
      yes: true,
    });
    assert.equal(report.state.lastRelease, null);
    assert.equal(report.state.lastAttempt.status, "triggered");
    assert.equal(report.state.lastAttempt.checks.public, "skipped");
    assert.equal(report.state.lastAttempt.checks.dokploy, "skipped");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease, undefined);
  assert.equal(state.lastAttempt.status, "triggered");
  assert.doesNotMatch(output.join("\n"), /Deployed unverified-deploy/);
});

test("wait verifies the latest attempt and promotes lastRelease", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-wait-promote-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Wait Promote", slug: "wait-promote" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [{ name: "status", path: "/api/status", expectStatus: 200, expectCommit: true }] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: {
      projectId: "project-1",
      environmentId: "environment-1",
      composeId: "compose-1",
    },
    lastAttempt: {
      commit: "waitcommit",
      tag: "wait-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
      status: "triggered",
      triggeredAt: "2026-06-18T00:01:00.000Z",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "wait-promote.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/wait-promote";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "wait-promote.example.test") {
      calls.push("public.verify");
      assert.equal(parsed.pathname, "/api/status");
      return new Response("running waitcommit", { status: 200 });
    }
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (endpoint === "compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "wait-promote-app",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/wait-promote/backend:wait-tag",
          "  frontend:",
          "    image: ghcr.io/acme/wait-promote/frontend:wait-tag",
        ].join("\n"),
        env: "",
      } });
    }
    if (endpoint === "domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "wait-promote.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "wait-promote.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (endpoint === "schedule.list") return Response.json({ json: [] });
    if (endpoint === "deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-1", status: "done", createdAt: "2026-06-18T00:02:00.000Z", title: "nstack wait-tag" },
      ] });
    }
    if (endpoint === "settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await waitForDeployment({ cwd, json: true });
    assert.equal(report.mode, "wait");
    assert.equal(report.release.tag, "wait-tag");
    assert.equal(report.state.lastRelease.tag, "wait-tag");
    assert.equal(report.state.lastAttempt.status, "verified");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.ok(calls.includes("public.verify"));
  assert.ok(calls.includes("compose.one"));

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.state.lastRelease.commit, "waitcommit");
  assert.equal(report.state.lastAttempt.status, "verified");

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease.tag, "wait-tag");
  assert.equal(state.lastAttempt.status, "verified");
  assert.equal(state.lastAttempt.triggeredAt, "2026-06-18T00:01:00.000Z");
  assert.match(state.lastAttempt.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("wait refuses to promote when public verification is skipped", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-wait-skip-verify-"));
  await assert.rejects(
    waitForDeployment({ cwd, skipVerify: true }),
    /cannot promote a release with --skip-verify/,
  );
});

test("redeploy retries the saved Compose release and promotes after verification", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-redeploy-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Redeploy App", slug: "redeploy-app" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [{ name: "status", path: "/api/status", expectStatus: 200, expectCommit: true }] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: {
      commit: "redeploycommit",
      tag: "redeploy-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "redeploy.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/redeploy";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "redeploy.example.test") {
      calls.push({ endpoint: "public.verify" });
      assert.equal(parsed.pathname, "/api/status");
      return new Response("running redeploycommit", { status: 200 });
    }
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, method: init.method, body });
    if (endpoint === "compose.redeploy") return Response.json({ json: {} });
    if (endpoint === "compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "redeploy-app-app",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/redeploy/backend:redeploy-tag",
          "  frontend:",
          "    image: ghcr.io/acme/redeploy/frontend:redeploy-tag",
        ].join("\n"),
        env: "",
      } });
    }
    if (endpoint === "domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "redeploy.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "redeploy.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (endpoint === "schedule.list") return Response.json({ json: [] });
    if (endpoint === "deployment.allByCompose") return Response.json({ json: [] });
    if (endpoint === "settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await redeploy({ cwd, json: true });
    assert.equal(report.mode, "redeploy");
    assert.equal(report.state.lastAttempt.status, "verified");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.ok(calls.some((call) => call.endpoint === "compose.redeploy"));
  assert.equal(calls.some((call) => call.endpoint === "compose.deploy"), false);
  assert.equal(calls.find((call) => call.endpoint === "compose.redeploy").body.composeId, "compose-1");
  assert.ok(calls.some((call) => call.endpoint === "public.verify"));

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.state.lastRelease.tag, "redeploy-tag");
  assert.equal(report.state.lastAttempt.checks.public, "passed");
  assert.equal(report.state.lastAttempt.checks.dokploy, "passed");

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease.tag, "redeploy-tag");
  assert.equal(state.lastAttempt.status, "verified");
});

test("redeploy --no-wait records a triggered attempt without verification", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-redeploy-nowait-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Redeploy No Wait", slug: "redeploy-no-wait" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: {
      commit: "nowaitcommit",
      tag: "nowait-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "redeploy-nowait.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/redeploy-nowait";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    assert.equal(endpoint, "compose.redeploy");
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await redeploy({ cwd, noWait: true, json: true });
    assert.equal(report.state.lastRelease.tag, "nowait-tag");
    assert.equal(report.state.lastAttempt.status, "triggered");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.deepEqual(calls, ["compose.redeploy"]);
  const report = JSON.parse(output.join("\n"));
  assert.equal(report.mode, "redeploy");
  assert.equal(report.state.lastAttempt.tag, "nowait-tag");
});

test("verified deploy preserves previous lastRelease in release history", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-release-history-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Release History", slug: "release-history" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    lastRelease: {
      commit: "previouscommit",
      tag: "previous-tag",
      builtAt: "2026-06-17T00:00:00.000Z",
    },
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_IMAGE_TAG"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "release-history.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/release-history";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  process.env.NSTACK_IMAGE_TAG = "new-tag";

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId" || endpoint === "schedule.list")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    await deploy({
      cwd,
      skipBuild: true,
      skipStatus: true,
      yes: true,
    });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease.tag, "new-tag");
  assert.deepEqual(state.releases.map((release) => release.tag), ["new-tag", "previous-tag"]);
  assert.match(state.releases[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("rollback deploys the previous saved verified release through Dokploy Compose", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-rollback-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Rollback App", slug: "rollback-app" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [{ name: "status", path: "/api/status", expectStatus: 200, expectCommit: true }] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: {
      environmentId: "environment-1",
      composeId: "compose-1",
    },
    lastRelease: {
      commit: "currentcommit",
      tag: "current-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
    releases: [
      {
        commit: "currentcommit",
        tag: "current-tag",
        builtAt: "2026-06-18T00:00:00.000Z",
        verifiedAt: "2026-06-18T00:01:00.000Z",
      },
      {
        commit: "previouscommit",
        tag: "previous-tag",
        builtAt: "2026-06-17T00:00:00.000Z",
        verifiedAt: "2026-06-17T00:01:00.000Z",
      },
    ],
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "rollback.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/rollback";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  let updatedComposeFile = "";
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "rollback.example.test") {
      calls.push({ endpoint: "public.verify" });
      assert.equal(parsed.pathname, "/api/status");
      return new Response("running previouscommit", { status: 200 });
    }
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, method: init.method, body });
    if (endpoint === "compose.update") {
      updatedComposeFile = body.composeFile;
      return Response.json({ json: {} });
    }
    if (endpoint === "compose.deploy") return Response.json({ json: {} });
    if (endpoint === "compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "rollback-app-app",
        composeFile: updatedComposeFile,
        env: "",
      } });
    }
    if (endpoint === "domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "rollback.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "rollback.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (endpoint === "schedule.list") return Response.json({ json: [] });
    if (endpoint === "deployment.allByCompose") return Response.json({ json: [] });
    if (endpoint === "settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await rollback(["previous"], { cwd, json: true });
    assert.equal(report.mode, "rollback");
    assert.equal(report.release.tag, "previous-tag");
    assert.equal(report.rollbackFrom.tag, "current-tag");
    assert.equal(report.state.lastAttempt.status, "verified");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const updateIndex = calls.findIndex((call) => call.endpoint === "compose.update");
  const deployIndex = calls.findIndex((call) => call.endpoint === "compose.deploy");
  assert.ok(updateIndex >= 0);
  assert.ok(deployIndex > updateIndex);
  assert.equal(calls.some((call) => call.endpoint === "compose.saveEnvironment"), false);
  assert.match(updatedComposeFile, /ghcr\.io\/acme\/rollback\/backend:previous-tag/);
  assert.match(updatedComposeFile, /ghcr\.io\/acme\/rollback\/frontend:previous-tag/);
  assert.doesNotMatch(updatedComposeFile, /current-tag/);
  assert.equal(calls.find((call) => call.endpoint === "compose.deploy").body.title, "nstack rollback previous-tag");
  assert.ok(calls.some((call) => call.endpoint === "public.verify"));

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.state.lastRelease.tag, "previous-tag");
  assert.equal(report.state.lastAttempt.rollback, true);
  assert.equal(report.state.lastAttempt.rollbackFrom.tag, "current-tag");
  assert.deepEqual(report.state.releases.map((release) => release.tag), ["previous-tag", "current-tag"]);

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease.tag, "previous-tag");
  assert.equal(state.lastAttempt.status, "verified");
  assert.equal(state.lastAttempt.checks.public, "passed");
  assert.equal(state.lastAttempt.checks.dokploy, "passed");
});

test("rollback --no-wait records a triggered rollback attempt without verification", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-rollback-nowait-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Rollback No Wait", slug: "rollback-no-wait" },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: {
      environmentId: "environment-1",
      composeId: "compose-1",
    },
    lastRelease: {
      commit: "currentcommit",
      tag: "current-tag",
      builtAt: "2026-06-18T00:00:00.000Z",
    },
    releases: [
      { commit: "currentcommit", tag: "current-tag", builtAt: "2026-06-18T00:00:00.000Z" },
      { commit: "previouscommit", tag: "previous-tag", builtAt: "2026-06-17T00:00:00.000Z" },
    ],
  }, null, 2)}\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "rollback-nowait.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/rollback-nowait";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const output = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== "dokploy.example.test") {
      throw new Error("rollback --no-wait should not run public verification");
    }
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, body });
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await rollback([], { cwd, noWait: true, json: true });
    assert.equal(report.state.lastRelease.tag, "current-tag");
    assert.equal(report.state.lastAttempt.status, "triggered");
    assert.equal(report.state.lastAttempt.rollback, true);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.deepEqual(calls.map((call) => call.endpoint), ["compose.update", "compose.deploy"]);
  const report = JSON.parse(output.join("\n"));
  assert.equal(report.release.tag, "previous-tag");
  assert.equal(report.state.lastAttempt.rollbackFrom.tag, "current-tag");
});

test("deploy fails after Dokploy deploy when post-deploy status audit finds drift", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-audit-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Audit App", slug: "audit-app" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "audit.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/audit";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);

    if (init.method === "GET" && endpoint === "project.all") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "environment.byProjectId") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "compose.search") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "domain.byComposeId") {
      const afterDeploy = calls.includes("compose.deploy");
      return Response.json({ json: afterDeploy ? [
        { domainId: "domain-1", host: "audit.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "audit.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] : [] });
    }
    if (init.method === "GET" && endpoint === "schedule.list") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "settings.health") return Response.json({ json: { status: "ok" } });
    if (init.method === "GET" && endpoint === "compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "audit-app-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/audit/backend:old",
          "  frontend:",
          "    image: ghcr.io/acme/audit/frontend:old",
          "",
        ].join("\n"),
      } });
    }

    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    await assert.rejects(
      deploy({
        cwd,
        skipBuild: true,
        skipVerify: true,
        statusTimeoutMs: 1,
        statusIntervalMs: 1,
        yes: true,
      }),
      (error) => {
        assert.match(error.message, /post-deploy status audit failed/);
        assert.match(error.message, /Remote Compose is not using expected image ghcr\.io\/acme\/audit\/backend:/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease, undefined);
  assert.equal(state.lastAttempt.status, "failed");
  assert.match(state.lastAttempt.error, /post-deploy status audit failed/);
  assert.match(state.lastAttempt.tag, /^[a-f0-9]{12}$|^local$/);
});

test("deploy can skip post-deploy status audit", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-skip-audit-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Skip Audit", slug: "skip-audit" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [] },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "skip-audit.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/skip-audit";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";

  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);
    if (init.method === "GET" && (endpoint === "project.all" || endpoint === "environment.byProjectId" || endpoint === "compose.search" || endpoint === "domain.byComposeId")) {
      return Response.json({ json: [] });
    }
    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    await deploy({
      cwd,
      skipBuild: true,
      skipStatus: true,
      yes: true,
    });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.equal(calls.includes("compose.one"), false);
  assert.ok(calls.includes("compose.deploy"));
  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.lastRelease.tag, "local");
  assert.equal(state.lastAttempt.status, "verified");
  assert.equal(state.lastAttempt.checks.public, "passed");
  assert.equal(state.lastAttempt.checks.dokploy, "skipped");
  assert.equal(state.lastAttempt.tag, "local");
});

test("deploy waits for post-deploy status audit to converge", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-deploy-audit-wait-"));
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Audit Wait", slug: "audit-wait" },
  paths: { backend: "backend", frontend: "frontend", frontendDockerfile: "frontend/Dockerfile" },
  verify: { endpoints: [], timeoutSeconds: 1 },
};\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);

  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_IMAGE_TAG"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NSTACK_DOMAIN = "audit-wait.example.test";
  process.env.NSTACK_REGISTRY = "ghcr.io/acme/audit-wait";
  process.env.DOKPLOY_URL = "https://dokploy.example.test";
  process.env.DOKPLOY_API_KEY = "dummy";
  process.env.NSTACK_IMAGE_TAG = "known";

  const calls = [];
  let composeOneCount = 0;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    calls.push(endpoint);

    if (init.method === "GET" && endpoint === "project.all") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "environment.byProjectId") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "compose.search") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "domain.byComposeId") {
      const afterDeploy = calls.includes("compose.deploy");
      return Response.json({ json: afterDeploy ? [
        { domainId: "domain-1", host: "audit-wait.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "audit-wait.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] : [] });
    }
    if (init.method === "GET" && endpoint === "schedule.list") return Response.json({ json: [] });
    if (init.method === "GET" && endpoint === "settings.health") return Response.json({ json: { status: "ok" } });
    if (init.method === "GET" && endpoint === "compose.one") {
      composeOneCount += 1;
      const tag = composeOneCount === 1 ? "old" : "known";
      return Response.json({ json: {
        composeId: "compose-1",
        name: "audit-wait-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          `    image: ghcr.io/acme/audit-wait/backend:${tag}`,
          "  frontend:",
          `    image: ghcr.io/acme/audit-wait/frontend:${tag}`,
          "",
        ].join("\n"),
      } });
    }

    const ids = {
      "project.create": { projectId: "project-1" },
      "environment.create": { environmentId: "environment-1" },
      "compose.create": { composeId: "compose-1" },
    };
    return Response.json({ json: ids[endpoint] || {} });
  };

  try {
    console.log = () => {};
    await deploy({
      cwd,
      skipBuild: true,
      skipVerify: true,
      statusTimeoutMs: 500,
      statusIntervalMs: 1,
      yes: true,
    });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.equal(composeOneCount, 2);
});
