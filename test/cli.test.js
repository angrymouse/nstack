import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

test("verify honors --cwd", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-verify-cwd-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Verify Cwd", slug: "verify-cwd", domain: "cwd-verify.example.test" },
    verify: { timeoutSeconds: 1, endpoints: [{ name: "ready", path: "/ready", expectStatus: 200 }] }
  };\n`);

  const originalFetch = globalThis.fetch;
  const output = [];
  const originalLog = console.log;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://cwd-verify.example.test/ready");
      return new Response("ok", { status: 200 });
    };
    console.log = (line = "") => output.push(String(line));

    await runCli(["verify", "--cwd", cwd]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  assert.deepEqual(output, ["Verified https://cwd-verify.example.test"]);
});

test("verify checks public endpoints concurrently", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-verify-parallel-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Verify Parallel", slug: "verify-parallel", domain: "parallel.example.test" },
    verify: { timeoutSeconds: 1, endpoints: [
      { name: "frontend", path: "/", expectStatus: 200 },
      { name: "api", path: "/api/status", expectStatus: 200 }
    ] }
  };\n`);

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let inFlight = 0;
  let parallelSeen = false;
  try {
    globalThis.fetch = async () => {
      inFlight += 1;
      if (inFlight > 1) parallelSeen = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response("ok", { status: 200 });
    };
    console.log = () => {};

    await runCli(["verify", "--cwd", cwd]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  assert.equal(parallelSeen, true);
});

test("cli accepts --cwd before the command", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-leading-cwd-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Leading Cwd", slug: "leading-cwd", domain: "leading-cwd.example.test" },
    verify: { timeoutSeconds: 1, endpoints: [{ name: "ready", path: "/", expectStatus: 200 }] }
  };\n`);

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://leading-cwd.example.test/");
      return new Response("ok", { status: 200 });
    };
    console.log = () => {};

    await runCli(["--cwd", cwd, "verify"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("cli accepts --flag=value syntax", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-equals-cwd-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Equals Cwd", slug: "equals-cwd", domain: "equals-cwd.example.test" },
    verify: { timeoutSeconds: 1, endpoints: [{ name: "ready", path: "/health", expectStatus: 200 }] }
  };\n`);

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://equals-cwd.example.test/health");
      return new Response("ok", { status: 200 });
    };
    console.log = () => {};

    await runCli([`--cwd=${cwd}`, "verify", "--json=false"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("cli rejects missing option values before running commands", async () => {
  await assert.rejects(
    runCli(["configure", "--domain", "--json"]),
    /Missing value for --domain/,
  );
});

test("cli rejects unknown options before running commands", async () => {
  await assert.rejects(
    runCli(["status", "--dokploy-apikey", "secret"]),
    /Unknown option: --dokploy-apikey/,
  );
});

test("cli allows option values that start with -- through equals syntax", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-leading-dash-value-"));
  const target = path.join(cwd, "app");

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["init", target, "--force", "--json", "--skip-install", "--name=--demo"]);
    assert.equal(report.app.name, "--demo");
  } finally {
    console.log = originalLog;
  }

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.app.slug, "demo");
});

test("cli runs the generated app client generator", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-client-cli-"));
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts", "nstack-client.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("client-ran.txt", process.argv.slice(2).join(" "));
`);

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "client", "gen", "--force", "--json"]);
    assert.deepEqual(report, { skipped: false, mode: "gen" });
  } finally {
    console.log = originalLog;
  }

  assert.equal(existsSync(path.join(cwd, "client-ran.txt")), true);
  assert.equal(readFileSync(path.join(cwd, "client-ran.txt"), "utf8"), "gen --force");
  assert.deepEqual(JSON.parse(output.join("\n")), { skipped: false, mode: "gen" });
});

test("cli runs the generated app dev orchestrator", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dev-cli-"));
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts", "dev.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("dev-ran.txt", "ok");
`);

  const output = [];
  const originalLog = console.log;
  const originalAllow = process.env.AI_ALLOW_DEVSERVER;
  try {
    process.env.AI_ALLOW_DEVSERVER = "1";
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "dev", "--json"]);
    assert.equal(report.script, "scripts/dev.mjs");
    assert.equal(typeof report.harness.detected, "boolean");
  } finally {
    console.log = originalLog;
    if (originalAllow === undefined) delete process.env.AI_ALLOW_DEVSERVER;
    else process.env.AI_ALLOW_DEVSERVER = originalAllow;
  }

  assert.equal(existsSync(path.join(cwd, "dev-ran.txt")), true);
  assert.equal(readFileSync(path.join(cwd, "dev-ran.txt"), "utf8"), "ok");
  const json = JSON.parse(output.join("\n"));
  assert.equal(json.script, "scripts/dev.mjs");
  assert.equal(typeof json.harness.detected, "boolean");
});

test("cli blocks nstack dev under AI harnesses unless explicitly allowed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dev-ai-block-"));
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts", "dev.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("dev-ran.txt", "bad");
`);

  const envKeys = ["NSTACK_AGENT_HARNESS", "AI_ALLOW_DEVSERVER"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.NSTACK_AGENT_HARNESS = "codex";
    delete process.env.AI_ALLOW_DEVSERVER;
    await assert.rejects(
      () => runCli(["--cwd", cwd, "dev"]),
      /Use `nstack devexec '<js>'`/,
    );
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  assert.equal(existsSync(path.join(cwd, "dev-ran.txt")), false);
});

test("cli runs the generated app devexec runner", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-devexec-cli-"));
  mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  writeFileSync(path.join(cwd, "scripts", "devexec.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("devexec-ran.txt", process.argv.slice(2).join("\\n"));
`);

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "--cwd", cwd,
      "devexec",
      "--code", "await apiJson('/status')",
      "--frontend-url", "http://127.0.0.1:3100",
      "--backend-url", "http://127.0.0.1:4100",
      "--timeout-ms", "1234",
      "--json",
    ]);
    assert.equal(report.script, "scripts/devexec.mjs");
    assert.equal(typeof report.harness.detected, "boolean");
  } finally {
    console.log = originalLog;
  }

  assert.equal(readFileSync(path.join(cwd, "devexec-ran.txt"), "utf8"), [
    "--code",
    "await apiJson('/status')",
    "--frontend-url",
    "http://127.0.0.1:3100",
    "--backend-url",
    "http://127.0.0.1:4100",
    "--timeout-ms",
    "1234",
  ].join("\n"));
  const json = JSON.parse(output.join("\n"));
  assert.equal(json.script, "scripts/devexec.mjs");
  assert.equal(typeof json.harness.detected, "boolean");
});

test("cli accepts --help and -h after commands", async () => {
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    await runCli(["deploy", "--help"]);
    await runCli(["env", "--help"]);
    await runCli(["status", "-h"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 3);
  for (const value of output) {
    assert.match(value, /^nstack\n/);
    assert.match(value, /nstack deploy/);
  }
});

test("cli reports version in text and json modes", async () => {
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    await runCli(["--version"]);
    await runCli(["version", "--json"]);
    await runCli(["deploy", "-v"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0], "nstack 0.1.0");
  assert.deepEqual(JSON.parse(output[1]), { name: "nstack", version: "0.1.0" });
  assert.equal(output[2], "nstack 0.1.0");
});

test("--ci fails instead of prompting for missing deploy settings", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-ci-mode-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "CI Mode", slug: "ci-mode" }
  };\n`);

  const originalIsTTY = process.stdin.isTTY;
  try {
    process.stdin.isTTY = true;
    await assert.rejects(
      runCli(["--cwd", cwd, "configure", "--ci"]),
      /Missing required value NSTACK_DOMAIN/,
    );
  } finally {
    process.stdin.isTTY = originalIsTTY;
  }
});

test("verify --json reports endpoint checks and prefers the latest attempted release", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-verify-json-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Verify Json", slug: "verify-json", domain: "verify-json.example.test" },
    verify: { timeoutSeconds: 1, endpoints: [
      { name: "ready", path: "/ready", expectStatus: 204 },
      { name: "status", path: "/api/status", expectStatus: 200, expectCommit: true }
    ] }
  };\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    lastRelease: { commit: "oldcommit", tag: "oldcommit", builtAt: "2026-06-17T00:00:00.000Z" },
    lastAttempt: {
      commit: "newcommit",
      tag: "newcommit",
      builtAt: "2026-06-17T00:01:00.000Z",
      status: "triggered",
      triggeredAt: "2026-06-17T00:02:00.000Z",
    },
  })}\n`);

  const originalFetch = globalThis.fetch;
  const output = [];
  const originalLog = console.log;
  try {
    globalThis.fetch = async (url) => {
      if (url === "https://verify-json.example.test/ready") return new Response(null, { status: 204 });
      assert.equal(url, "https://verify-json.example.test/api/status");
      return new Response("running newcommit", { status: 200 });
    };
    console.log = (line = "") => output.push(String(line));

    const report = await runCli(["--cwd", cwd, "verify", "--json"]);
    assert.equal(report.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.ok, true);
  assert.equal(report.app.url, "https://verify-json.example.test");
  assert.equal(report.release.commit, "newcommit");
  assert.deepEqual(report.endpoints.map((endpoint) => [endpoint.name, endpoint.ok, endpoint.status]), [
    ["ready", true, 204],
    ["status", true, 200],
  ]);
  assert.doesNotMatch(output.join("\n"), /Verified/);
});

test("verify checks source-backed runtime commit sha", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-verify-source-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default {
    app: { name: "Verify Source", slug: "verify-source", domain: "verify-source.example.test" },
    deploy: {
      buildMode: "compose",
      source: {
        sourceType: "gitea",
        repository: "git@git.example.test:acme/verify-source.git",
        branch: "main"
      }
    },
    verify: { timeoutSeconds: 1, endpoints: [
      { name: "status", path: "/api/status", expectStatus: 200, expectCommit: true }
    ] }
  };\n`);
  writeFileSync(path.join(cwd, ".nstack", "state.json"), `${JSON.stringify({
    lastAttempt: {
      commit: "1234567890abcdef1234567890abcdef12345678",
      tag: "1234567890ab",
      builtAt: "2026-06-17T00:01:00.000Z",
      status: "triggered",
      triggeredAt: "2026-06-17T00:02:00.000Z",
    },
  })}\n`);

  const originalFetch = globalThis.fetch;
  const output = [];
  const originalLog = console.log;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://verify-source.example.test/api/status");
      return new Response("running 1234567890abcdef1234567890abcdef12345678", { status: 200 });
    };
    console.log = (line = "") => output.push(String(line));

    const report = await runCli(["--cwd", cwd, "verify", "--json"]);
    assert.equal(report.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const report = JSON.parse(output.join("\n"));
  assert.equal(report.release.commit, "1234567890abcdef1234567890abcdef12345678");
  assert.equal(report.endpoints[0].expectedCommit, "1234567890abcdef1234567890abcdef12345678");
  assert.equal(report.endpoints[0].ok, true);
});
