import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { compareVersions } from "../src/update.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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

test("cli skips client generation outside an nstack app", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-client-cli-"));

  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "client", "gen", "--force", "--json"]);
    assert.deepEqual(report, { skipped: true });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(JSON.parse(output.join("\n")), { skipped: true });
});

test("cli rejects dev outside an nstack app", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dev-cli-"));

  await assert.rejects(
    () => runCli(["--cwd", cwd, "dev"]),
    /requires an nstack app root/,
  );
});

test("cli runs generated app setup in the CLI", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-setup-cli-"));
  const fakeBin = path.join(cwd, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), "export default { app: { name: 'App', slug: 'app' } };\n");
  writeFileSync(path.join(cwd, "package.json"), "{\"private\":true}\n");
  writeFileSync(path.join(fakeBin, "pnpm"), "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then printf '10.18.3\\n'; exit 0; fi\nexit 0\n");
  chmodSync(path.join(fakeBin, "pnpm"), 0o755);

  const output = [];
  const originalLog = console.log;
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    console.log = (value = "") => output.push(String(value));
    const report = await runCli(["--cwd", cwd, "setup", "--skip-install", "--skip-tools", "--skip-docker", "--json"]);
    assert.equal(report.mode, "generated-app");
    assert.equal(report.installedDependencies, false);
  } finally {
    console.log = originalLog;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  const json = JSON.parse(output.at(-1));
  assert.equal(json.mode, "generated-app");
  assert.equal(json.installedDependencies, false);
});

test("cli check honors --skip-docker for apps with cache resources", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-check-skip-docker-"));
  const fakeBin = path.join(cwd, "bin");
  mkdirSync(path.join(cwd, "backend", "api"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend", "app", "generated"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), "export default { app: { name: 'App', slug: 'app' } };\n");
  writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"check-app\",\"private\":true}\n");
  writeFileSync(path.join(cwd, "backend", "encore.app"), "{\"id\":\"\"}\n");
  writeFileSync(path.join(cwd, "backend", "api", "cache.ts"), [
    'import { CacheCluster } from "encore.dev/storage/cache";',
    'export const cache = new CacheCluster("sessions");',
  ].join("\n"));
  writeFileSync(path.join(fakeBin, "pnpm"), [
    "#!/usr/bin/env sh",
    "if [ \"$1\" = \"--version\" ]; then printf '10.18.3\\n'; exit 0; fi",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path.join(fakeBin, "pnpm"), 0o755);
  writeFakeEncoreForCheck(path.join(fakeBin, "encore"));
  writeFileSync(path.join(fakeBin, "docker"), [
    "#!/usr/bin/env sh",
    `printf docker-called > ${JSON.stringify(path.join(cwd, "docker-called"))}`,
    "exit 99",
    "",
  ].join("\n"));
  chmodSync(path.join(fakeBin, "docker"), 0o755);

  const output = [];
  const originalLog = console.log;
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "--cwd", cwd,
      "check",
      "--skip-install",
      "--skip-tools",
      "--skip-docker",
      "--json",
    ]);
    assert.equal(report.mode, "cli");
  } finally {
    console.log = originalLog;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  assert.equal(existsSync(path.join(cwd, "docker-called")), false);
  assert.equal(JSON.parse(output.at(-1)).mode, "cli");
});

test("cli blocks nstack dev under AI harnesses unless explicitly allowed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dev-ai-block-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), "export default { app: { name: 'App', slug: 'app' } };\n");
  writeFileSync(path.join(cwd, "package.json"), "{\"private\":true}\n");
  mkdirSync(path.join(cwd, "backend"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "backend", "encore.app"), "{\"id\":\"\"}\n");
  writeFileSync(path.join(cwd, "frontend", "package.json"), "{\"private\":true}\n");

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

function writeFakeEncoreForCheck(file) {
  writeFileSync(file, [
    "#!/usr/bin/env node",
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    'if (args[0] === "version") { console.log("encore version v0.0.0-test"); process.exit(0); }',
    'if (args[0] === "check") process.exit(0);',
    'if (args[0] === "gen" && args[1] === "client") {',
    '  const output = args[args.indexOf("--output") + 1];',
    "  mkdirSync(path.dirname(output), { recursive: true });",
    "  writeFileSync(output, [",
    '    "export type BaseURL = string\\n",',
    '    "/**\\n",',
    '    " * Environment returns a BaseURL for calling the Encore API in the given environment.\\n",',
    '    " */\\n",',
    '    "export function Environment(name: string): BaseURL {\\n",',
    '    "    return \\"https://\\" + name + \\".encr.app\\"\\n",',
    '    "}\\n",',
    '    "/**\\n",',
    '    " * PreviewEnv returns a BaseURL for calling the Encore API in the given preview environment.\\n",',
    '    " */\\n",',
    '    "export function PreviewEnv(pr: number | string): BaseURL {\\n",',
    '    "    return Environment(`pr${pr}`)\\n",',
    '    "}\\n",',
    '  ].join(""));',
    "  process.exit(0);",
    "}",
    'console.error("unexpected fake encore args: " + args.join(" "));',
    "process.exit(1);",
    "",
  ].join("\n"));
  chmodSync(file, 0o755);
}

test("cli validates devexec input before starting the stack", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-devexec-cli-"));
  writeFileSync(path.join(cwd, "nstack.config.mjs"), "export default { app: { name: 'App', slug: 'app' } };\n");
  writeFileSync(path.join(cwd, "package.json"), "{\"private\":true}\n");
  mkdirSync(path.join(cwd, "backend"), { recursive: true });
  mkdirSync(path.join(cwd, "frontend"), { recursive: true });
  writeFileSync(path.join(cwd, "backend", "encore.app"), "{\"id\":\"\"}\n");
  writeFileSync(path.join(cwd, "frontend", "package.json"), "{\"private\":true}\n");

  await assert.rejects(
    () => runCli([
      "--cwd", cwd,
      "devexec",
      "--frontend-url", "http://127.0.0.1:3100",
      "--backend-url", "http://127.0.0.1:4100",
      "--timeout-ms", "1234",
    ]),
    /Missing JavaScript/,
  );
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

  assert.equal(output[0], `nstack ${packageJson.version}`);
  assert.deepEqual(JSON.parse(output[1]), { name: "nstack", version: packageJson.version });
  assert.equal(output[2], `nstack ${packageJson.version}`);
});

test("update check reports newer release metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://nstack.example.test/api/releases/latest");
      return new Response(JSON.stringify({
        version: "99.0.0",
        branch: "main",
        commit: "abcdef123456",
        repository: "https://git.example.test/nstack",
        url: "https://git.example.test/nstack",
        fetchedAt: "2026-06-23T00:00:00.000Z",
        changelog: [
          { commit: "abcdef123456", message: "ship update command", date: "2026-06-23T00:00:00.000Z" },
        ],
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };
    console.log = (value = "") => output.push(String(value));

    await runCli([
      "update",
      "--check",
      "--json",
      "--metadata-url",
      "https://nstack.example.test/api/releases/latest",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const report = JSON.parse(output[0]);
  assert.equal(report.checked, true);
  assert.equal(report.updated, false);
  assert.equal(report.updateAvailable, true);
  assert.equal(report.currentVersion, packageJson.version);
  assert.equal(report.latestVersion, "99.0.0");
  assert.equal(report.release.changelog[0].message, "ship update command");
});

test("version comparison handles common semver shapes", () => {
  assert.equal(compareVersions("0.1.94", "0.1.93"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2"), 0);
  assert.equal(compareVersions("1.2.0", "1.2.1"), -1);
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
