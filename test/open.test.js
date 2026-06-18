import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { openTarget } from "../src/open.js";

function setupApp() {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-open-"));
  mkdirSync(path.join(cwd, ".nstack"), { recursive: true });
  writeFileSync(path.join(cwd, "nstack.config.mjs"), `export default { app: { name: "Open App", slug: "open-app" } };\n`);
  writeFileSync(path.join(cwd, ".nstack", "local.env"), [
    "NSTACK_DOMAIN=open.example.test",
    "DOKPLOY_URL=https://dokploy.example.test",
    "DOKPLOY_API_KEY=dummy",
    "",
  ].join("\n"));
  return cwd;
}

test("open prints the app URL without launching when --print is set", async () => {
  const cwd = setupApp();
  const originalLog = console.log;
  const output = [];
  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await openTarget([], { cwd, print: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(report.kind, "app");
  assert.equal(report.url, "https://open.example.test");
  assert.equal(report.opened, false);
  assert.deepEqual(output, ["https://open.example.test"]);
});

test("open can return the Dokploy dashboard URL as json", async () => {
  const cwd = setupApp();
  const originalLog = console.log;
  const output = [];
  let report;
  try {
    console.log = (value = "") => output.push(String(value));
    report = await openTarget(["dashboard"], { cwd, json: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(report.kind, "dashboard");
  assert.equal(report.url, "https://dokploy.example.test");
  assert.equal(report.opened, false);
  assert.equal(JSON.parse(output.join("\n")).url, "https://dokploy.example.test");
});

test("cli wires open with --cwd before the command", async () => {
  const cwd = setupApp();
  const originalLog = console.log;
  const output = [];
  try {
    console.log = (value = "") => output.push(String(value));
    await runCli(["--cwd", cwd, "open", "dashboard", "--print"]);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, ["https://dokploy.example.test"]);
});
