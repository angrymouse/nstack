import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { cancelDeployment, inspectDeployment, listDeployments, logs } from "../src/deployments.js";

function setupApp(prefix) {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Deployments App", slug: "deployments-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=deployments.example.test",
    "NSTACK_REGISTRY=ghcr.io/acme/deployments",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  writeFileSync(path.join(cwd, ".nstack", "state.json"), JSON.stringify({
    dokploy: { composeId: "compose-1" },
  }));
  return cwd;
}

test("deployments lists recent Dokploy Compose deployments", async () => {
  const cwd = setupApp("nstack-deployments-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    assert.equal(init.method, "GET");
    assert.equal(parsed.pathname, "/api/deployment.allByCompose");
    assert.equal(parsed.searchParams.get("composeId"), "compose-1");
    return Response.json({ json: [
      { deploymentId: "deploy-old", status: "failed", createdAt: "2026-06-16T00:00:00.000Z", title: "old" },
      { deploymentId: "deploy-new", status: "done", createdAt: "2026-06-17T00:00:00.000Z", title: "new" },
    ] });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await listDeployments({ cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(report.deployments.map((deployment) => deployment.id), ["deploy-new", "deploy-old"]);
  assert.deepEqual(JSON.parse(output.join("\n")).deployments.map((deployment) => deployment.status), ["done", "failed"]);
});

test("deployments can filter by status and limit output", async () => {
  const cwd = setupApp("nstack-deployments-filter-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/api/deployment.allByCompose");
    return Response.json({ json: [
      { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-18T00:00:00.000Z" },
      { deploymentId: "deploy-running", status: "running", createdAt: "2026-06-17T00:00:00.000Z" },
      { deploymentId: "deploy-failed", status: "failed", createdAt: "2026-06-16T00:00:00.000Z" },
    ] });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await listDeployments({ cwd, status: "failed,running", limit: "1", json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.total, 3);
  assert.equal(report.count, 1);
  assert.deepEqual(report.filters, { status: ["failed", "running"], limit: 1 });
  assert.deepEqual(report.deployments.map((deployment) => deployment.id), ["deploy-running"]);
  assert.deepEqual(JSON.parse(output.join("\n")).deployments.map((deployment) => deployment.status), ["running"]);
});

test("inspect reads deployment metadata, logs, and recovery hints", async () => {
  const cwd = setupApp("nstack-inspect-latest-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method, path: parsed.pathname, search: parsed.search });
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-old", status: "done", createdAt: "2026-06-16T00:00:00.000Z", title: "old" },
        { deploymentId: "deploy-new", status: "failed", createdAt: "2026-06-17T00:00:00.000Z", title: "new" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      assert.equal(parsed.searchParams.get("deploymentId"), "deploy-new");
      assert.equal(parsed.searchParams.get("tail"), "25");
      return Response.json({ json: { logs: "build failed\n" } });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await inspectDeployment([], { cwd, tail: "25" });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-new");
  assert.equal(report.deployment.status, "failed");
  assert.equal(report.logs, "build failed\n");
  assert.ok(report.nextSteps.includes("Run `nstack redeploy` to retry the current saved release."));
  assert.deepEqual(calls.map((call) => call.path), ["/api/deployment.allByCompose", "/api/deployment.readLogs"]);
  assert.ok(output.includes("deployment: deploy-new"));
  assert.ok(output.includes("logs (tail 25):"));
});

test("inspect can read an explicit deployment id and print json", async () => {
  const cwd = setupApp("nstack-inspect-explicit-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-active", status: "running", createdAt: "2026-06-17T00:00:00.000Z", title: "active" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      assert.equal(parsed.searchParams.get("deploymentId"), "deploy-active");
      return Response.json({ json: { logs: "still running\n" } });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await inspectDeployment(["deploy-active"], { cwd, json: true });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-active");
  assert.deepEqual(report.nextSteps, [
    "Run `nstack logs deploy-active --follow` to stream the active deployment.",
    "Run `nstack cancel deploy-active` to stop it.",
    "Run `nstack wait` after it finishes to verify and promote the release.",
  ]);
  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.logs, "still running\n");
  assert.equal(parsed.deployment.status, "running");
});

test("cli wires deployment inspect alias", async () => {
  const cwd = setupApp("nstack-inspect-cli-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-cli-inspect", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      return Response.json({ json: { logs: "done\n" } });
    }
    return Response.json({ json: {} });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "deployment", "inspect", "--json"]);
    assert.equal(report.deploymentId, "deploy-cli-inspect");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.parse(output.join("\n")).nextSteps[0], "Run `nstack status --check --json` to confirm domains, schedules, images, and env are converged.");
});

test("logs reads latest deployment logs by default", async () => {
  const cwd = setupApp("nstack-logs-latest-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method, path: parsed.pathname, search: parsed.search });
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-old", createdAt: "2026-06-16T00:00:00.000Z" },
        { deploymentId: "deploy-new", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      assert.equal(parsed.searchParams.get("deploymentId"), "deploy-new");
      assert.equal(parsed.searchParams.get("tail"), "50");
      return Response.json({ json: { logs: "line one\nline two" } });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await logs([], { cwd, tail: "50" });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-new");
  assert.equal(report.logs, "line one\nline two");
  assert.deepEqual(output, ["line one\nline two"]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/deployment.allByCompose", "/api/deployment.readLogs"]);
});

test("logs can read a specific deployment id without listing", async () => {
  const cwd = setupApp("nstack-logs-specific-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    assert.equal(parsed.pathname, "/api/deployment.readLogs");
    assert.equal(parsed.searchParams.get("deploymentId"), "deploy-explicit");
    return Response.json({ json: ["line a", "line b"] });
  };

  try {
    console.log = () => {};
    const report = await logs(["deploy-explicit"], { cwd, json: true });
    assert.equal(report.logs, "line a\nline b");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, ["/api/deployment.readLogs"]);
});

test("logs --follow streams appended log output until the deployment finishes", async () => {
  const cwd = setupApp("nstack-logs-follow-");
  const calls = [];
  let listCount = 0;
  let logCount = 0;
  const originalFetch = globalThis.fetch;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/deployment.allByCompose") {
      listCount += 1;
      return Response.json({ json: [
        {
          deploymentId: "deploy-follow",
          status: listCount === 1 ? "running" : "done",
          createdAt: "2026-06-17T00:00:00.000Z",
        },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      logCount += 1;
      assert.equal(parsed.searchParams.get("deploymentId"), "deploy-follow");
      return Response.json({ json: {
        logs: logCount === 1 ? "line one\n" : "line one\nline two\n",
      } });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    report = await logs([], {
      cwd,
      follow: true,
      writeLog: (chunk) => output.push(String(chunk)),
      statusIntervalMs: "1",
      timeoutMs: "1000",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-follow");
  assert.equal(report.status, "done");
  assert.equal(report.finished, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.logs, "line one\nline two\n");
  assert.deepEqual(output, ["line one\n", "line two\n"]);
  assert.deepEqual(calls, [
    "/api/deployment.allByCompose",
    "/api/deployment.readLogs",
    "/api/deployment.allByCompose",
    "/api/deployment.readLogs",
  ]);
});

test("logs --follow --json waits without streaming raw log chunks", async () => {
  const cwd = setupApp("nstack-logs-follow-json-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  const stream = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-json", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      return Response.json({ json: { logs: "json log\n" } });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await logs(["deploy-json"], {
      cwd,
      follow: true,
      json: true,
      writeLog: (chunk) => stream.push(String(chunk)),
    });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-json");
  assert.equal(report.logs, "json log\n");
  assert.deepEqual(stream, []);
  assert.equal(JSON.parse(output.join("\n")).status, "done");
});

test("cli wires logs -f and --deployment", async () => {
  const cwd = setupApp("nstack-logs-cli-follow-");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-cli", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    if (parsed.pathname === "/api/deployment.readLogs") {
      assert.equal(parsed.searchParams.get("deploymentId"), "deploy-cli");
      return Response.json({ json: { logs: "cli log\n" } });
    }
    return Response.json({ json: {} });
  };

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "--cwd",
      cwd,
      "logs",
      "-f",
      "--json",
      "--deployment",
      "deploy-cli",
    ]);
    assert.equal(report.follow, true);
    assert.equal(report.deploymentId, "deploy-cli");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.parse(output.join("\n")).logs, "cli log\n");
});

test("cancel cancels the latest active deployment by default", async () => {
  const cwd = setupApp("nstack-cancel-active-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    if (parsed.pathname === "/api/deployment.allByCompose") {
      return Response.json({ json: [
        { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-17T01:00:00.000Z" },
        { deploymentId: "deploy-running", status: "running", createdAt: "2026-06-17T00:00:00.000Z" },
      ] });
    }
    return Response.json({ json: {} });
  };

  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await cancelDeployment([], { cwd });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.deploymentId, "deploy-running");
  assert.deepEqual(calls.map((call) => call.path), ["/api/deployment.allByCompose", "/api/deployment.killProcess"]);
  assert.deepEqual(calls[1].body, { deploymentId: "deploy-running" });
  assert.deepEqual(output, ["Cancelled deployment deploy-running"]);
});

test("cancel can cancel an explicit deployment id without listing", async () => {
  const cwd = setupApp("nstack-cancel-explicit-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method, path: parsed.pathname, body: init.body ? JSON.parse(init.body) : null });
    assert.equal(parsed.pathname, "/api/deployment.killProcess");
    return Response.json({ json: {} });
  };

  try {
    console.log = () => {};
    const report = await cancelDeployment(["deploy-explicit"], { cwd, json: true });
    assert.equal(report.deploymentId, "deploy-explicit");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [{ method: "POST", path: "/api/deployment.killProcess", body: { deploymentId: "deploy-explicit" } }]);
});

test("cancel refuses to pick a completed deployment by default", async () => {
  const cwd = setupApp("nstack-cancel-completed-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/api/deployment.allByCompose");
    return Response.json({ json: [
      { deploymentId: "deploy-done", status: "done", createdAt: "2026-06-17T00:00:00.000Z" },
    ] });
  };

  try {
    await assert.rejects(
      () => cancelDeployment([], { cwd, json: true }),
      /No active Dokploy deployment found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
