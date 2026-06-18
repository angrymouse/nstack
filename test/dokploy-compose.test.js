import assert from "node:assert/strict";
import { test } from "node:test";
import { DokployProvider } from "../src/providers/dokploy.js";

test("upsertCompose saves Compose env with Dokploy environment endpoint", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (init.method === "GET" && parsed.pathname === "/api/trpc/compose.search") {
      return Response.json({ json: [] });
    }
    if (init.method === "POST" && parsed.pathname === "/api/compose.create") {
      return Response.json({ json: { composeId: "compose-1" } });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: {} },
    });
    const composeId = await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=one\n");
    assert.equal(composeId, "compose-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const create = calls.find((call) => call.path === "/api/compose.create");
  assert.equal(create.body.env, undefined);

  const save = calls.find((call) => call.path === "/api/compose.saveEnvironment");
  assert.deepEqual(save.body, { composeId: "compose-1", env: "API_SECRET=one\n" });
});

test("upsertCompose falls back to compose.update when saveEnvironment is unavailable", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (parsed.pathname === "/api/compose.saveEnvironment") {
      return Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404 });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: { composeId: "compose-1" } },
    });
    const composeId = await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=two\n");
    assert.equal(composeId, "compose-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const updates = calls.filter((call) => call.path === "/api/compose.update");
  assert.equal(updates.length, 2);
  assert.equal(updates[0].body.composeFile, "services: {}");
  assert.deepEqual(updates[1].body, { composeId: "compose-1", env: "API_SECRET=two\n" });
});
