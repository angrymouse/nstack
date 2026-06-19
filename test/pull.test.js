import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { pull } from "../src/pull.js";

test("pull hydrates target state and declared secrets from Dokploy", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-pull-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Pull App", slug: "pull-app" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "resources.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
import { Bucket } from "encore.dev/storage/objects";
export const db = new SQLDatabase("app", {});
export const uploads = new Bucket("uploads", {});
function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
function CronJob(name, config) { return { name, config }; }
export const refresh = new CronJob("refresh", { every: "5m" });
`);
  writeFileSync(path.join(cwd, ".nstack", "local.staging.env"), [
    "NSTACK_TARGET=staging",
    "NSTACK_DOMAIN=staging.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/pull-app",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") {
      return Response.json({ json: [{ projectId: "project-1", name: "Pull App" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/environment.byProjectId") {
      return Response.json({ json: [{ environmentId: "environment-1", name: "staging" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/trpc/compose.search") {
      return Response.json({ json: [{ composeId: "compose-1", name: "pull-app-app" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/trpc/postgres.search") {
      return Response.json({ json: [{ postgresId: "postgres-1", name: "pull-app-postgres" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "pull-app-app",
        composeStatus: "done",
        composeType: "docker-compose",
        env: [
          "NSTACK_POSTGRES_PASSWORD=remote-postgres-password",
          "NSTACK_MINIO_ACCESS_KEY=remote-minio-access",
          "NSTACK_MINIO_SECRET_KEY=remote-minio-secret",
          "API_SECRET=remote-api-secret",
          "UNDECLARED_SECRET=ignored",
          "",
        ].join("\n"),
      } });
    }
    if (init.method === "GET" && parsed.pathname === "/api/schedule.list") {
      return Response.json({ json: [
        { scheduleId: "schedule-1", name: "nstack-pull-app-refresh" },
      ] });
    }
    return Response.json({ json: [] });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await pull({ cwd, target: "staging", json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.staging.json"), "utf8"));
  const secrets = readFileSync(path.join(cwd, ".nstack", "secrets.staging.env"), "utf8");
  const json = output.join("\n");

  assert.equal(state.dokploy.projectId, "project-1");
  assert.equal(state.dokploy.environmentId, "environment-1");
  assert.equal(state.dokploy.composeId, "compose-1");
  assert.equal(state.dokploy.postgresId, "postgres-1");
  assert.deepEqual(state.dokploy.schedules, { refresh: "schedule-1" });
  assert.equal(state.infra.postgres.password, "remote-postgres-password");
  assert.equal(state.infra.objectStorage.accessKey, "remote-minio-access");
  assert.equal(state.infra.objectStorage.secretKey, "remote-minio-secret");
  assert.equal(state.infra.objectStorage.endpoint, "http://pull-app-minio:9000");
  assert.match(secrets, /API_SECRET=remote-api-secret/);
  assert.doesNotMatch(secrets, /UNDECLARED_SECRET/);
  assert.doesNotMatch(secrets, /NSTACK_MINIO/);
  assert.deepEqual(report.secrets.written, ["API_SECRET"]);
  assert.doesNotMatch(json, /remote-api-secret|remote-postgres-password|remote-minio-access|remote-minio-secret/);
});

test("pull preserves existing local secret values unless forced", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-pull-preserve-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Pull Preserve", slug: "pull-preserve" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "secret.ts"), `function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=preserve.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/preserve",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=local-secret\n");

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") {
      return Response.json({ json: [{ projectId: "project-1", name: "Pull Preserve" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/environment.byProjectId") {
      return Response.json({ json: [{ environmentId: "environment-1", name: "production" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/trpc/compose.search") {
      return Response.json({ json: [{ composeId: "compose-1", name: "pull-preserve-app" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/compose.one") {
      return Response.json({ json: { composeId: "compose-1", env: "API_SECRET=remote-secret\n" } });
    }
    return Response.json({ json: [] });
  };

  try {
    console.log = () => {};
    const first = await pull({ cwd, json: true });
    assert.deepEqual(first.secrets.skipped, ["API_SECRET"]);
    assert.match(readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8"), /API_SECRET=local-secret/);

    const second = await pull({ cwd, json: true, force: true });
    assert.deepEqual(second.secrets.written, ["API_SECRET"]);
    assert.match(readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8"), /API_SECRET=remote-secret/);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("env pull --all hydrates all remote app env keys without printing values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-env-pull-all-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Env Pull All", slug: "env-pull-all" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=env-pull-all.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/env-pull-all",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === "GET" && parsed.pathname === "/api/project.all") {
      return Response.json({ json: [{ projectId: "project-1", name: "Env Pull All" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/environment.byProjectId") {
      return Response.json({ json: [{ environmentId: "environment-1", name: "production" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/trpc/compose.search") {
      return Response.json({ json: [{ composeId: "compose-1", name: "env-pull-all-app" }] });
    }
    if (init.method === "GET" && parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "env-pull-all-app",
        env: [
          "NSTACK_POSTGRES_PASSWORD=remote-postgres-password",
          "NSTACK_MINIO_ACCESS_KEY=remote-minio-access",
          "NSTACK_MINIO_SECRET_KEY=remote-minio-secret",
          "API_SECRET=remote-api-secret",
          "UNDECLARED_SECRET=remote-undeclared-secret",
          "EMPTY_SECRET=",
          "",
        ].join("\n"),
      } });
    }
    return Response.json({ json: [] });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    await runCli(["--cwd", cwd, "env", "pull", "--all", "--json"]);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  const secrets = readFileSync(path.join(cwd, ".nstack", "secrets.env"), "utf8");
  const report = JSON.parse(output.join("\n"));
  const json = output.join("\n");

  assert.match(secrets, /API_SECRET=remote-api-secret/);
  assert.match(secrets, /UNDECLARED_SECRET=remote-undeclared-secret/);
  assert.match(secrets, /EMPTY_SECRET=/);
  assert.doesNotMatch(secrets, /NSTACK_POSTGRES_PASSWORD/);
  assert.doesNotMatch(secrets, /NSTACK_MINIO_ACCESS_KEY|NSTACK_MINIO_SECRET_KEY/);
  assert.equal(report.secrets.mode, "all");
  assert.deepEqual(report.secrets.available, ["API_SECRET", "EMPTY_SECRET", "UNDECLARED_SECRET"]);
  assert.deepEqual(report.secrets.written, ["API_SECRET", "EMPTY_SECRET", "UNDECLARED_SECRET"]);
  assert.deepEqual(report.secrets.missing, []);
  assert.doesNotMatch(json, /remote-api-secret|remote-undeclared-secret|remote-postgres-password|remote-minio-access|remote-minio-secret/);
});
