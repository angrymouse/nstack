import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { showStatus, statusCheckError } from "../src/status.js";

test("status reports local link state and Dokploy remote state", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Status App", slug: "status-app" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "cron.ts"), `function CronJob(name, config) { return { name, config }; }
export const refresh = new CronJob("refresh", { every: "5m" });
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=status.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/status",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: {
      projectId: "project-1",
      environmentId: "environment-1",
      composeId: "compose-1",
      schedules: { refresh: "schedule-1" },
    },
    lastRelease: { commit: "abc123", tag: "abc123", builtAt: "2026-06-17T00:00:00.000Z" },
  }));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method, path: parsed.pathname, search: parsed.search });
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "status-app-app",
        composeStatus: "done",
        sourceType: "raw",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/status/backend:abc123",
          "  frontend:",
          "    image: ghcr.io/acme/status/frontend:abc123",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "status.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "status.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") {
      return Response.json({ json: [
        { scheduleId: "schedule-1", name: "nstack-status-app-refresh", cronExpression: "*/5 * * * *", enabled: true, serviceName: "backend" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-17T00:05:00.000Z", title: "nstack abc123" },
      ] });
    }
    if (parsed.pathname === "/api/settings.health") {
      return Response.json({ json: { status: "ok" } });
    }
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  const output = [];
  console.log = (value = "") => output.push(String(value));
  let report;
  try {
    report = await showStatus({ cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.app.url, "https://status.example.test");
  assert.equal(report.state.lastRelease.commit, "abc123");
  assert.equal(report.remote.ok, true);
  assert.equal(report.remote.compose.status, "done");
  assert.equal(report.drift.ok, true);
  assert.deepEqual(report.nextSteps, []);
  assert.deepEqual(report.remote.domains.map((domain) => `${domain.path}:${domain.serviceName}`), ["/:frontend", "/api:backend"]);
  assert.deepEqual(report.remote.schedules.map((schedule) => schedule.name), ["nstack-status-app-refresh"]);
  assert.deepEqual(report.remote.deployments.map((deployment) => deployment.id), ["deploy-done"]);
  assert.deepEqual(report.drift.expected.images, ["ghcr.io/acme/status/backend:abc123", "ghcr.io/acme/status/frontend:abc123"]);
  assert.equal(JSON.parse(output.join("\n")).remote.compose.id, "compose-1");
  assert.deepEqual(calls.map((call) => call.path).sort(), [
    "/api/compose.one",
    "/api/deployment.allByCompose",
    "/api/domain.byComposeId",
    "/api/schedule.list",
    "/api/settings.health",
  ].sort());
});

test("status uses the latest deployment attempt for image drift without promoting it", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-attempt-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Attempt App", slug: "attempt-app" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=attempt.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/attempt",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: { commit: "oldcommit", tag: "oldtag", builtAt: "2026-06-17T00:00:00.000Z" },
    lastAttempt: {
      commit: "newcommit",
      tag: "newtag",
      builtAt: "2026-06-17T00:05:00.000Z",
      status: "failed",
      error: "public verify failed",
      triggeredAt: "2026-06-17T00:05:01.000Z",
      failedAt: "2026-06-17T00:05:30.000Z",
    },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "attempt-app-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/attempt/backend:newtag",
          "  frontend:",
          "    image: ghcr.io/acme/attempt/frontend:newtag",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "attempt.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "attempt.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") return Response.json({ json: [] });
    if (parsed.pathname === "/api/deployment.allByCompose") return Response.json({ json: [] });
    if (parsed.pathname === "/api/settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    const report = await showStatus({ cwd, json: true });
    assert.equal(report.state.lastRelease.tag, "oldtag");
    assert.equal(report.state.lastAttempt.tag, "newtag");
    assert.equal(report.state.lastAttempt.status, "failed");
    assert.deepEqual(report.drift.expected.images, [
      "ghcr.io/acme/attempt/backend:newtag",
      "ghcr.io/acme/attempt/frontend:newtag",
    ]);
    assert.equal(report.drift.ok, true);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("status surfaces active Dokploy deployment attempts with log and cancel hints", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-active-deploy-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Active Deploy", slug: "active-deploy" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=active-deploy.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/active-deploy",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: { commit: "abc123", tag: "abc123", builtAt: "2026-06-17T00:00:00.000Z" },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "active-deploy-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/active-deploy/backend:abc123",
          "  frontend:",
          "    image: ghcr.io/acme/active-deploy/frontend:abc123",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "active-deploy.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "active-deploy.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") return Response.json({ json: [] });
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-running", status: "running", createdAt: "2026-06-17T00:10:00.000Z", title: "nstack active" },
        { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  const output = [];
  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await showStatus({ cwd });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.drift.ok, false);
  assert.ok(report.drift.issues.includes("Latest Dokploy deployment deploy-running is still running."));
  assert.equal(report.remote.deployments[0].id, "deploy-running");
  assert.ok(report.nextSteps.includes("Run `nstack logs deploy-running --follow` to follow the active deployment."));
  assert.ok(report.nextSteps.includes("Run `nstack cancel deploy-running` to stop it."));
  assert.ok(output.includes("active-deploy: needs attention"));
  assert.ok(output.includes("deployment: deploy-running running nstack active"));
  assert.equal(output.includes("deployments:"), false);
});

test("status fails convergence when the latest Dokploy deployment failed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-failed-deploy-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Failed Deploy", slug: "failed-deploy" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "status.ts"), `export const ok = true;\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=failed-deploy.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/failed-deploy",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
    lastRelease: { commit: "abc123", tag: "abc123", builtAt: "2026-06-17T00:00:00.000Z" },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "failed-deploy-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/failed-deploy/backend:abc123",
          "  frontend:",
          "    image: ghcr.io/acme/failed-deploy/frontend:abc123",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "failed-deploy.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "failed-deploy.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") return Response.json({ json: [] });
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-failed", status: "failed", createdAt: "2026-06-17T00:10:00.000Z", title: "nstack abc123" },
        { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  let report;
  let checkExitCode;
  try {
    console.log = () => {};
    report = await showStatus({ cwd, json: true, check: true });
    checkExitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.drift.ok, false);
  assert.equal(checkExitCode, 1);
  assert.ok(report.drift.issues.includes("Latest Dokploy deployment deploy-failed failed with status failed."));
  assert.ok(report.nextSteps.includes("Run `nstack logs deploy-failed` to inspect the failed deployment."));
  assert.ok(report.nextSteps.includes("Run `nstack redeploy` to retry the current saved release, or `nstack rollback` to return to the previous verified release."));
  assert.match(statusCheckError(report).message, /Latest Dokploy deployment deploy-failed failed/);
});

test("status reports Dokploy drift against current app expectations", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-drift-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Drift App", slug: "drift-app" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "cron.ts"), `function CronJob(name, config) { return { name, config }; }
export const refresh = new CronJob("refresh", { every: "5m" });
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=drift.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/drift",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: {
      composeId: "compose-1",
      schedules: { refresh: "schedule-1" },
    },
    lastRelease: { commit: "abc123", tag: "abc123", builtAt: "2026-06-17T00:00:00.000Z" },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "drift-app-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/drift/backend:old",
          "  frontend:",
          "    image: ghcr.io/acme/drift/frontend:old",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "drift.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "drift.example.test", path: "/api", serviceName: "backend", port: 3000, https: true, stripPath: false },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") {
      return Response.json({ json: [
        { scheduleId: "schedule-1", name: "nstack-drift-app-refresh", cronExpression: "0 * * * *", enabled: false, serviceName: "frontend", command: "old cron command" },
        { scheduleId: "schedule-2", name: "nstack-drift-app-stale", cronExpression: "0 0 * * *", enabled: true, serviceName: "backend" },
      ] });
    }
    if (parsed.pathname === "/api/settings.health") {
      return Response.json({ json: { status: "ok" } });
    }
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  console.log = () => {};
  let report;
  let checkExitCode;
  try {
    report = await showStatus({ cwd, json: true, check: true });
    checkExitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.drift.ok, false);
  assert.equal(checkExitCode, 1);
  assert.ok(report.drift.issues.some((issue) => issue.includes("points at port 3000, expected 8080")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("stripPath is false, expected true")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("uses 0 * * * *, expected */5 * * * *")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("is disabled")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("runs on service frontend, expected backend")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("command is out of sync with the private Encore cron runner")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("Stale Dokploy schedule nstack-drift-app-stale")));
  assert.ok(report.drift.issues.some((issue) => issue.includes("ghcr.io/acme/drift/backend:abc123")));
  assert.ok(report.nextSteps.includes("Run `nstack deploy` to sync Dokploy with the current app."));
  assert.match(statusCheckError(report).message, /Next steps:\n  - Run `nstack deploy`/);
});

test("status compares Dokploy Compose env without exposing secret values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-env-drift-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Env Drift", slug: "env-drift" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "resources.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
import { Bucket } from "encore.dev/storage/objects";
export const db = new SQLDatabase("app", {});
export const uploads = new Bucket("uploads", {});
function secret(name) { return name; }
export const apiSecret = secret("API_SECRET");
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=env-drift.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/env-drift",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "secrets.env"), "API_SECRET=local-secret\n");
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
    infra: {
      postgres: { password: "local-postgres-password" },
      objectStorage: {
        accessKey: "local-minio-access",
        secretKey: "local-minio-secret",
      },
    },
    lastRelease: { commit: "abc123", tag: "abc123", builtAt: "2026-06-17T00:00:00.000Z" },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "env-drift-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: [
          "services:",
          "  backend:",
          "    image: ghcr.io/acme/env-drift/backend:abc123",
          "  frontend:",
          "    image: ghcr.io/acme/env-drift/frontend:abc123",
          "",
        ].join("\n"),
        env: [
          "API_SECRET=remote-secret",
          "NSTACK_POSTGRES_PASSWORD=remote-postgres-password",
          "NSTACK_MINIO_ACCESS_KEY=remote-minio-access",
          "NSTACK_MINIO_SECRET_KEY=remote-minio-secret",
          "",
        ].join("\n"),
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "env-drift.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "env-drift.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") {
      return Response.json({ json: [] });
    }
    if (parsed.pathname === "/api/settings.health") {
      return Response.json({ json: { status: "ok" } });
    }
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  const output = [];
  console.log = (value = "") => output.push(String(value));
  let report;
  try {
    report = await showStatus({ cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  const json = output.join("\n");
  assert.equal(report.drift.ok, false);
  assert.deepEqual(report.remote.compose.envKeys, ["API_SECRET", "NSTACK_MINIO_ACCESS_KEY", "NSTACK_MINIO_SECRET_KEY", "NSTACK_POSTGRES_PASSWORD"]);
  assert.deepEqual(report.drift.expected.envKeys, ["API_SECRET", "NSTACK_MINIO_ACCESS_KEY", "NSTACK_MINIO_SECRET_KEY", "NSTACK_POSTGRES_PASSWORD"]);
  assert.ok(report.drift.issues.includes("Dokploy environment key API_SECRET differs from local state."));
  assert.ok(report.drift.issues.includes("Dokploy environment key NSTACK_POSTGRES_PASSWORD differs from local state."));
  assert.ok(report.drift.issues.includes("Dokploy environment key NSTACK_MINIO_ACCESS_KEY differs from local state."));
  assert.ok(report.drift.issues.includes("Dokploy environment key NSTACK_MINIO_SECRET_KEY differs from local state."));
  assert.ok(report.nextSteps.includes("Run `nstack env push` to sync local app secrets to Dokploy and redeploy the current release."));
  assert.doesNotMatch(json, /local-secret|remote-secret|local-postgres-password|remote-postgres-password|local-minio-access|local-minio-secret|remote-minio-access|remote-minio-secret/);
});

test("status tells users to pull when local generated infra state is missing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-missing-infra-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Missing Infra", slug: "missing-infra" } };\n`);
  writeFileSync(path.join(cwd, "backend", "api", "resources.ts"), `import { SQLDatabase } from "encore.dev/storage/sqldb";
import { Bucket } from "encore.dev/storage/objects";
export const db = new SQLDatabase("app", {});
export const uploads = new Bucket("uploads", {});
`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=missing-infra.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/missing-infra",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: {
        composeId: "compose-1",
        name: "missing-infra-app",
        composeStatus: "done",
        composeType: "docker-compose",
        composeFile: "services:\n  backend:\n    image: ghcr.io/acme/missing-infra/backend:abc123\n",
      } });
    }
    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-1", host: "missing-infra.example.test", path: "/", serviceName: "frontend", port: 3000, https: true },
        { domainId: "domain-2", host: "missing-infra.example.test", path: "/api", serviceName: "backend", port: 8080, https: true, stripPath: true },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") return Response.json({ json: [] });
    if (parsed.pathname === "/api/settings.health") return Response.json({ json: { status: "ok" } });
    return Response.json({ json: {} });
  };

  const originalLog = console.log;
  console.log = () => {};
  let report;
  try {
    report = await showStatus({ cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.ok(report.drift.issues.includes("Missing local infrastructure state for NSTACK_POSTGRES_PASSWORD; run `nstack pull` to recover it from Dokploy before deploying."));
  assert.ok(report.drift.issues.includes("Missing local infrastructure state for NSTACK_MINIO_SECRET_KEY; run `nstack pull` to recover it from Dokploy before deploying."));
  assert.ok(report.nextSteps.includes("Run `nstack pull` to recover generated infrastructure secrets from Dokploy."));
  assert.doesNotMatch(statusCheckError(report).message, /run `nstack deploy`\./);
});

test("status stays local when Dokploy credentials are not linked", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-status-local-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Local App", slug: "local-app" } };\n`);

  const envKeys = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_DOMAIN"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called for unlinked status");
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    const report = await showStatus({ cwd, json: true });
    assert.equal(report.deploy.linked, false);
    assert.equal(report.remote.ok, false);
    assert.match(report.remote.reason, /Missing Dokploy URL/);
    assert.ok(report.drift.issues.includes("Missing Dokploy URL or API key. Run `nstack configure`."));
    assert.equal(report.drift.issues.some((issue) => issue.includes("Missing Dokploy domain")), false);
    assert.ok(report.nextSteps.includes("Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`."));
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
