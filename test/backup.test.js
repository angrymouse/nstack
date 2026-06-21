import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

test("backup writes recoverable snapshots and downloads Dokploy data artifacts", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-backup-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
  app: { name: "Backup App", slug: "backup-app" },
  paths: { backend: "backend" },
};\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=backup.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy-api-key",
    "DOKPLOY_PROJECT=Backup App",
    "DOKPLOY_ENVIRONMENT=production",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    dokploy: {
      projectId: "project-1",
      environmentId: "environment-1",
      composeId: "compose-1",
      postgresId: "postgres-1",
    },
    infra: {
      postgres: {
        appName: "backup-app-postgres",
        host: "backup-app-postgres:5432",
        database: "appdb",
        user: "nstack",
        password: "postgres-secret",
      },
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(cwd, "backend", "api", "db.ts"), [
    "import { secret } from 'encore.dev/config';",
    "import { SQLDatabase } from 'encore.dev/storage/sqldb';",
    "export const db = new SQLDatabase('appdb', { migrations: './migrations' });",
    "export const apiSecret = secret('API_SECRET');",
    "",
  ].join("\n"));

  let createdBackup = null;
  let manualBackupRan = false;
  const calls = [];
  const output = [];
  const envKeys = [
    "DOKPLOY_URL",
    "DOKPLOY_API_KEY",
    "DOKPLOY_PROJECT",
    "DOKPLOY_ENVIRONMENT",
    "NSTACK_DOMAIN",
    "NSTACK_TARGET",
    "NSTACK_BACKUP_DESTINATION_ID",
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "storage.example.test") {
      return new Response(Buffer.from("SQL"), { status: 200 });
    }

    const endpoint = parsed.pathname.replace(/^\/api\/(?:trpc\/)?/, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, endpoint, body });

    if (method === "GET") {
      if (endpoint === "project.all") return Response.json({ json: [{ projectId: "project-1", name: "Backup App" }] });
      if (endpoint === "environment.byProjectId") return Response.json({ json: [{ environmentId: "environment-1", name: "production" }] });
      if (endpoint === "compose.search") return Response.json({ json: [{ composeId: "compose-1", name: "backup-app-app", appName: "backup-app" }] });
      if (endpoint === "postgres.search") return Response.json({ json: [{ postgresId: "postgres-1", name: "backup-app-postgres", appName: "backup-app-postgres" }] });
      if (endpoint === "environment.one") return Response.json({ json: { environmentId: "environment-1", name: "production" } });
      if (endpoint === "compose.one") {
        return Response.json({ json: {
          composeId: "compose-1",
          name: "backup-app-app",
          appName: "backup-app",
          composeFile: "services:\n  backend:\n    image: backend\n",
          env: "API_SECRET=super-secret\nNSTACK_POSTGRES_PASSWORD=postgres-secret\n",
        } });
      }
      if (endpoint === "domain.byComposeId" || endpoint === "schedule.list") return Response.json({ json: [] });
      if (endpoint === "postgres.one") {
        return Response.json({ json: {
          postgresId: "postgres-1",
          name: "backup-app-postgres",
          appName: "backup-app-postgres",
          databaseName: "appdb",
          databaseUser: "nstack",
          databasePassword: "",
          backups: createdBackup ? [createdBackup] : [],
        } });
      }
      if (endpoint === "destination.all") return Response.json({ json: [{ destinationId: "destination-1", name: "Operator backups", provider: "s3" }] });
      if (endpoint === "destination.one") {
        return Response.json({ json: {
          destinationId: "destination-1",
          name: "Operator backups",
          provider: "s3",
          endpoint: "https://storage.example.test",
          bucket: "nstack",
          region: "us-east-1",
          accessKey: "access-key",
          secretAccessKey: "secret-key",
        } });
      }
      if (endpoint === "backup.listBackupFiles") {
        return Response.json({ json: manualBackupRan ? [{
          Path: `backup-app-postgres/${createdBackup.prefix}/2026-06-21.sql.gz`,
          IsDir: false,
          Size: 3,
        }] : [] });
      }
    }

    if (endpoint === "backup.create") {
      createdBackup = {
        backupId: "backup-1",
        destinationId: body.destinationId,
        prefix: body.prefix,
        database: body.database,
        databaseType: body.databaseType,
        backupType: body.backupType,
      };
      return Response.json({ json: {} });
    }
    if (endpoint === "backup.manualBackupPostgres") {
      manualBackupRan = true;
      return Response.json({ json: true });
    }
    return Response.json({ json: {} });
  };

  try {
    console.log = (line = "") => output.push(String(line));
    const report = await runCli(["--cwd", cwd, "backup", "--json"]);
    assert.equal(report.sizeBytes, 3);
    assert.match(report.backupDir, /\.nstack\/backups\/prod\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-utc$/);
    assert.equal(report.data.postgres.status, "ok");
    assert.equal(existsSync(path.join(report.backupDir, "postgres.sql.gz")), true);
    assert.equal(existsSync(path.join(report.backupDir, "local.env")), false);
    assert.equal(existsSync(path.join(report.backupDir, "secrets.env")), false);
    assert.equal(readFileSync(path.join(report.backupDir, "postgres.sql.gz"), "utf8"), "SQL");

    const target = readFileSync(path.join(report.backupDir, "nstack.target.json"), "utf8");
    const env = readFileSync(path.join(report.backupDir, "compose.env"), "utf8");
    const remote = readFileSync(path.join(report.backupDir, "dokploy.resources.json"), "utf8");
    assert.match(target, /"apiKey": "dummy-api-key"/);
    assert.match(env, /^API_SECRET=super-secret$/m);
    assert.match(env, /^NSTACK_POSTGRES_PASSWORD=postgres-secret$/m);
    assert.match(remote, /postgres-secret|super-secret/);
    assert.match(remote, /"databasePassword": ""/);
    assert.equal(JSON.parse(output.join("\n")).sizeBytes, 3);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.equal(calls.some((call) => call.endpoint === "backup.create"), true);
  assert.equal(calls.some((call) => call.endpoint === "backup.manualBackupPostgres"), true);
  assert.equal(calls.some((call) => call.endpoint === "destination.create"), false);
});
