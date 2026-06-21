import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

test("undeploy removes Dokploy resources and clears deployed state", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-undeploy-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Undeploy App", slug: "undeploy-app" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=undeploy.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "DOKPLOY_PROJECT=Undeploy App",
    "DOKPLOY_ENVIRONMENT=production",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: {
      projectId: "project-1",
      environmentId: "environment-1",
      composeId: "compose-1",
      postgresId: "postgres-1",
      redisId: "redis-1",
      schedules: { old: "schedule-from-state" },
    },
    lastRelease: { tag: "old-tag", commit: "old-commit" },
    lastAttempt: { status: "verified", tag: "old-tag", commit: "old-commit" },
    releases: [{ tag: "old-tag", commit: "old-commit" }],
  }, null, 2));

  const calls = [];
  const output = [];
  const originalNoBackups = process.env.NSTACK_NO_BACKUPS_ON_DELETION;
  process.env.NSTACK_NO_BACKUPS_ON_DELETION = "1";
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, search: parsed.search, body });

    if (parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({ json: [
        { domainId: "domain-home", host: "undeploy.example.test", path: "/", serviceName: "frontend" },
        { domainId: "domain-api", host: "undeploy.example.test", path: "/api", serviceName: "backend" },
      ] });
    }
    if (parsed.pathname === "/api/schedule.list") {
      return Response.json({ json: [
        { scheduleId: "schedule-listed", name: "nstack-undeploy-app-hourly" },
      ] });
    }
    if (parsed.pathname === "/api/project.all") {
      return Response.json({ json: [
        {
          projectId: "project-1",
          name: "Undeploy App",
          environments: [{
            environmentId: "environment-1",
            applications: [],
            compose: [],
            postgres: [],
            mysql: [],
            mariadb: [],
            redis: [],
            mongo: [],
            libsql: [],
          }],
        },
      ] });
    }
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await runCli(["--cwd", cwd, "undeploy", "--yes", "--json"]);
    assert.equal(report.deleted.compose, true);
    assert.equal(report.deleted.postgres, true);
    assert.equal(report.deleted.redis, true);
    assert.equal(report.deleted.project, true);
    assert.equal(report.deleted.domains.length, 2);
    assert.equal(report.deleted.schedules.length, 2);
    assert.equal(report.cleanup.unusedImagesPruned, true);
    assert.equal(report.cleanup.unusedVolumesPruned, true);
    assert.equal(report.cleanup.dockerBuilderCachePruned, true);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    if (originalNoBackups === undefined) delete process.env.NSTACK_NO_BACKUPS_ON_DELETION;
    else process.env.NSTACK_NO_BACKUPS_ON_DELETION = originalNoBackups;
  }

  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]), [
    ["/api/domain.delete", { domainId: "domain-home" }],
    ["/api/domain.delete", { domainId: "domain-api" }],
    ["/api/schedule.delete", { scheduleId: "schedule-listed" }],
    ["/api/schedule.delete", { scheduleId: "schedule-from-state" }],
    ["/api/compose.delete", { composeId: "compose-1", deleteVolumes: true }],
    ["/api/postgres.remove", { postgresId: "postgres-1" }],
    ["/api/redis.remove", { redisId: "redis-1" }],
    ["/api/project.remove", { projectId: "project-1" }],
    ["/api/settings.cleanStoppedContainers", {}],
    ["/api/settings.cleanUnusedImages", {}],
    ["/api/settings.cleanUnusedVolumes", {}],
    ["/api/settings.cleanDockerBuilder", {}],
  ]);
  const state = JSON.parse(readFileSync(path.join(cwd, ".nstack", "state.json"), "utf8"));
  assert.equal(state.dokploy, undefined);
  assert.equal(state.lastRelease, undefined);
  assert.equal(state.lastAttempt, undefined);
  assert.equal(state.releases.length, 1);
  assert.equal(state.lastUndeploy.deleted.project, "project-1");
  assert.doesNotMatch(output.join("\n"), /dummy|old-commit/);
});

test("undeploy requires confirmation unless --yes is passed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-undeploy-confirm-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Confirm App", slug: "confirm-app" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=confirm.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { projectId: "project-1", environmentId: "environment-1", composeId: "compose-1" },
  }, null, 2));

  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({ json: {} });
  };
  try {
    await assert.rejects(
      runCli(["--cwd", cwd, "undeploy", "--json"]),
      /Pass `--yes`/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false);
  assert.equal(existsSync(path.join(cwd, ".nstack", "state.json")), true);
});

test("undeploy blocks destructive deletion when required backup cannot be created", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-undeploy-backup-block-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Backup Block", slug: "backup-block" },
  paths: { backend: "backend" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=backup-block.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "DOKPLOY_PROJECT=Backup Block",
    "DOKPLOY_ENVIRONMENT=production",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: {
      projectId: "project-1",
      environmentId: "environment-1",
      composeId: "compose-1",
      postgresId: "postgres-1",
    },
    infra: {
      postgres: {
        appName: "backup-block-postgres",
        host: "backup-block-postgres:5432",
        database: "app",
        user: "nstack",
        password: "postgres-secret",
      },
    },
  }, null, 2));

  const calls = [];
  const envKeys = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_PROJECT", "DOKPLOY_ENVIRONMENT", "NSTACK_DOMAIN", "NSTACK_TARGET", "NSTACK_BACKUP_DESTINATION_ID", "NSTACK_NO_BACKUPS_ON_DELETION"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const method = init.method || "GET";
    calls.push({ method, endpoint });

    if (method === "GET") {
      if (endpoint === "project.all") return Response.json({ json: [{ projectId: "project-1", name: "Backup Block" }] });
      if (endpoint === "environment.byProjectId") return Response.json({ json: [{ environmentId: "environment-1", name: "production" }] });
      if (endpoint === "compose.search") return Response.json({ json: [{ composeId: "compose-1", name: "backup-block-app", appName: "backup-block" }] });
      if (endpoint === "postgres.search") return Response.json({ json: [{ postgresId: "postgres-1", name: "backup-block-postgres", appName: "backup-block-postgres" }] });
      if (endpoint === "environment.one") return Response.json({ json: { environmentId: "environment-1", name: "production" } });
      if (endpoint === "compose.one") return Response.json({ json: { composeId: "compose-1", name: "backup-block-app", appName: "backup-block", composeFile: "services: {}\n" } });
      if (endpoint === "domain.byComposeId" || endpoint === "schedule.list") return Response.json({ json: [] });
      if (endpoint === "postgres.one") return Response.json({ json: { postgresId: "postgres-1", appName: "backup-block-postgres", databaseName: "app", databaseUser: "nstack", backups: [] } });
      if (endpoint === "destination.all") return Response.json({ json: [] });
    }
    return Response.json({ json: {} });
  };

  try {
    await assert.rejects(
      runCli(["--cwd", cwd, "undeploy", "--yes", "--json"]),
      /No Dokploy backup destination is configured/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.equal(calls.some((call) => call.method === "POST" && call.endpoint === "compose.delete"), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.endpoint === "postgres.remove"), false);
});
