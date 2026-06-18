import assert from "node:assert/strict";
import { test } from "node:test";
import { DokployProvider } from "../src/providers/dokploy.js";

test("syncSchedules creates, updates, and prunes Dokploy compose schedules", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, search: parsed.search, body });

    if (init.method === "GET" && parsed.pathname === "/api/schedule.list") {
      return Response.json({
        json: [
          { scheduleId: "existing-refresh", name: "nstack-cron-app-refresh" },
          { scheduleId: "stale-listed", name: "nstack-cron-app-stale" },
          { scheduleId: "manual", name: "manual-schedule" },
        ],
      });
    }
    if (init.method === "POST" && parsed.pathname === "/api/schedule.create") {
      return Response.json({ json: { scheduleId: "created-daily" } });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "cron-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: { schedules: { old: "stale-state" } } },
    });
    const result = await provider.syncSchedules("compose-1", [
      {
        name: "refresh",
        schedule: "*/5 * * * *",
        normalizedSchedule: { kind: "schedule", value: "*/5 * * * *" },
        endpoint: { method: "POST", path: "/refresh" },
      },
      {
        name: "daily",
        schedule: "every:1440",
        normalizedSchedule: { kind: "every", minutes: 1440, value: "1440" },
        endpoint: { method: "POST", path: "/daily" },
      },
    ]);

    assert.deepEqual(result, { refresh: "existing-refresh", daily: "created-daily" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const update = calls.find((call) => call.path === "/api/schedule.update");
  assert.equal(update.body.scheduleId, "existing-refresh");
  assert.equal(update.body.scheduleType, "compose");
  assert.equal(update.body.composeId, "compose-1");
  assert.equal(update.body.serviceName, "backend");
  assert.equal(update.body.cronExpression, "*/5 * * * *");
  assert.match(update.body.command, /node --input-type=module -e/);

  const create = calls.find((call) => call.path === "/api/schedule.create");
  assert.equal(create.body.name, "nstack-cron-app-daily");
  assert.equal(create.body.cronExpression, "0 0 * * *");

  const deletes = calls
    .filter((call) => call.path === "/api/schedule.delete")
    .map((call) => call.body.scheduleId)
    .sort();
  assert.deepEqual(deletes, ["stale-listed", "stale-state"]);
});
