import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  installPackageManagerDependencies,
  loadDefaultPackageManager,
  packageManagerInstallCommands,
  promptPackageManager,
} from "../src/package-manager.js";

test("package manager prompt can remember pnpm as default", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-package-manager-"));
  const fakeBin = path.join(cwd, "bin");
  const settingsFile = path.join(cwd, "settings.json");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, "pnpm"), `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  printf '10.33.2\\n'
  exit 0
fi
exit 0
`);
  chmodSync(path.join(fakeBin, "pnpm"), 0o755);

  const originalPath = process.env.PATH;
  const originalPackageManager = process.env.NSTACK_PACKAGE_MANAGER;
  delete process.env.NSTACK_PACKAGE_MANAGER;
  process.env.PATH = `${fakeBin}:${originalPath || ""}`;
  const prompts = [];
  const prompter = {
    yes: false,
    async select(name, message, choices, options) {
      prompts.push([name, message, choices.map((choice) => choice.value), options.defaultIndex]);
      return choices[options.defaultIndex];
    },
    async confirm(name, message, options) {
      prompts.push([name, message, options.defaultValue]);
      return true;
    },
  };

  try {
    const selected = await promptPackageManager(prompter, { file: settingsFile });
    assert.equal(selected.name, "pnpm");
    assert.equal(selected.version, "10.33.2");
    assert.equal(loadDefaultPackageManager(settingsFile), "pnpm");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPackageManager === undefined) delete process.env.NSTACK_PACKAGE_MANAGER;
    else process.env.NSTACK_PACKAGE_MANAGER = originalPackageManager;
  }

  assert.deepEqual(prompts[0], ["NSTACK_PACKAGE_MANAGER", "Package manager", ["pnpm"], 0]);
  assert.equal(prompts[1][0], "NSTACK_REMEMBER_PACKAGE_MANAGER");
  assert.match(readFileSync(settingsFile, "utf8"), /"packageManager": "pnpm"/);
});

test("package manager install commands approve pnpm builds", () => {
  assert.deepEqual(packageManagerInstallCommands("pnpm").map((command) => command.label), [
    "pnpm install --no-frozen-lockfile",
    "pnpm approve-builds",
  ]);
});

test("pnpm install falls back when approve-builds --all is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-pnpm-approve-fallback-"));
  const fakeBin = path.join(cwd, "bin");
  const app = path.join(cwd, "app");
  const log = path.join(cwd, "pnpm.log");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(path.join(app, "pnpm-workspace.yaml"), "packages:\n  - backend\n  - frontend\n");
  writeFileSync(path.join(fakeBin, "pnpm"), `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  printf '10.18.3\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$NSTACK_FAKE_PNPM_LOG"
if [ "$1" = "help" ] && [ "$2" = "approve-builds" ]; then
  printf 'Approve dependencies for running scripts during installation\\n'
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
if [ "$1" = "ignored-builds" ]; then
  printf 'Automatically ignored builds during installation:\\n'
  printf '  @parcel/watcher\\n'
  printf '  esbuild\\n'
  printf 'hint: To allow the execution of build scripts for a package, add its name to "pnpm.onlyBuiltDependencies" in your "package.json", then run "pnpm rebuild".\\n'
  exit 0
fi
if [ "$1" = "rebuild" ]; then
  exit 0
fi
exit 1
`);
  chmodSync(path.join(fakeBin, "pnpm"), 0o755);

  const originalPath = process.env.PATH;
  const originalLog = process.env.NSTACK_FAKE_PNPM_LOG;
  process.env.PATH = `${fakeBin}:${originalPath || ""}`;
  process.env.NSTACK_FAKE_PNPM_LOG = log;
  try {
    assert.deepEqual(installPackageManagerDependencies("pnpm", { cwd: app }), [
      "pnpm install --no-frozen-lockfile",
      "pnpm ignored-builds",
      "pnpm rebuild",
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.NSTACK_FAKE_PNPM_LOG;
    else process.env.NSTACK_FAKE_PNPM_LOG = originalLog;
  }

  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "install --no-frozen-lockfile",
    "help approve-builds",
    "ignored-builds",
    "rebuild",
  ]);
  assert.match(readFileSync(path.join(app, "pnpm-workspace.yaml"), "utf8"), /onlyBuiltDependencies:\n  - "@parcel\/watcher"\n  - esbuild\n/);
});
