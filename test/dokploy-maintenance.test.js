import assert from "node:assert/strict";
import { test } from "node:test";
import { DokployProvider } from "../src/providers/dokploy.js";

test("validateAppDomain uses Dokploy DNS validation with the current server IP", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (init.method === "GET" && parsed.pathname === "/api/settings.getIp") {
      return Response.json({ json: "203.0.113.10" });
    }
    if (init.method === "POST" && parsed.pathname === "/api/domain.validateDomain") {
      return Response.json({ json: { isValid: true, resolvedIp: "203.0.113.10" } });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "dns-app", domain: "dns.example.test" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: {},
    });

    const report = await provider.validateAppDomain();
    assert.deepEqual(report, {
      domain: "dns.example.test",
      valid: true,
      resolvedIp: "203.0.113.10",
      expectedIp: "203.0.113.10",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const validate = calls.find((call) => call.path === "/api/domain.validateDomain");
  assert.deepEqual(validate.body, { domain: "dns.example.test", serverIp: "203.0.113.10" });
});

test("validateAppDomain warns when domains do not point at Dokploy", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));

    if (init.method === "GET" && parsed.pathname === "/api/settings.getIp") {
      return Response.json({ json: "203.0.113.10" });
    }
    if (init.method === "POST" && parsed.pathname === "/api/domain.validateDomain") {
      return Response.json({ json: { isValid: false, resolvedIp: "198.51.100.20" } });
    }
    return Response.json({ json: {} });
  };

  try {
    console.warn = (message = "") => warnings.push(String(message));
    const provider = new DokployProvider({
      config: {
        app: { slug: "dns-app", domain: "dns.example.test" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: {},
    });

    const report = await provider.validateAppDomain();
    assert.deepEqual(report, {
      domain: "dns.example.test",
      valid: false,
      resolvedIp: "198.51.100.20",
      expectedIp: "203.0.113.10",
      warning: "DNS for dns.example.test resolves to 198.51.100.20, expected 203.0.113.10. Point the domain at Dokploy before deploying.",
    });
    assert.deepEqual(warnings, [
      "Warning: DNS for dns.example.test resolves to 198.51.100.20, expected 203.0.113.10. Point the domain at Dokploy before deploying.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("validateAppDomain can block when DNS validation is strict", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));

    if (init.method === "GET" && parsed.pathname === "/api/settings.getIp") {
      return Response.json({ json: "203.0.113.10" });
    }
    if (init.method === "POST" && parsed.pathname === "/api/domain.validateDomain") {
      return Response.json({ json: { isValid: false, resolvedIp: "198.51.100.20" } });
    }
    return Response.json({ json: {} });
  };

  try {
    console.warn = (message = "") => warnings.push(String(message));
    const provider = new DokployProvider({
      config: {
        app: { slug: "dns-app", domain: "dns.example.test" },
        deploy: {
          dnsValidation: "block",
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: {},
    });

    await assert.rejects(
      provider.validateAppDomain(),
      /DNS for dns\.example\.test resolves to 198\.51\.100\.20, expected 203\.0\.113\.10/,
    );
    assert.deepEqual(warnings, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("Dokploy maintenance enables cleanup and prunes unused images", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "cleanup-app", domain: "cleanup.example.test" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy", serverId: "server-1" } },
      },
      state: {},
    });

    await provider.enableDockerCleanup();
    await provider.cleanStoppedContainers();
    await provider.cleanUnusedImages();
    await provider.cleanUnusedVolumes();
    await provider.cleanDockerBuilder();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => [call.method, call.path, call.body]), [
    ["POST", "/api/settings.updateDockerCleanup", { enableDockerCleanup: true, serverId: "server-1" }],
    ["POST", "/api/settings.cleanStoppedContainers", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanUnusedImages", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanUnusedVolumes", { serverId: "server-1" }],
    ["POST", "/api/settings.cleanDockerBuilder", { serverId: "server-1" }],
  ]);
});
