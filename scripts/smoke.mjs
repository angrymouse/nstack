import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "nstack-smoke-"));
const appDir = path.join(tempRoot, "app");
let exitCode = 0;

try {
  run(process.execPath, ["bin/nstack.js", "help"]);
  run(process.execPath, ["bin/nstack.js", "init", appDir, "--force", "--yes"]);
  run(process.execPath, ["--check", path.join(appDir, "nstack.config.mjs")]);
} catch (error) {
  console.error(error.message);
  exitCode = error.exitCode || 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (exitCode !== 0) process.exit(exitCode);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed with exit code ${result.status || 1}`);
    error.exitCode = result.status || 1;
    throw error;
  }
}
