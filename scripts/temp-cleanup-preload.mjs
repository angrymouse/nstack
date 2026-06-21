import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const createdDirs = new Set();
const tempRoot = path.resolve(tmpdir());
const keepTemp = process.env.NSTACK_TEST_KEEP_TMP === "1";

const originalMkdtempSync = fs.mkdtempSync;
const originalMkdtemp = fs.mkdtemp;
const originalPromisesMkdtemp = fs.promises?.mkdtemp?.bind(fs.promises);

fs.mkdtempSync = function patchedMkdtempSync(prefix, options) {
  const dir = originalMkdtempSync.call(this, prefix, options);
  trackTempDir(dir);
  return dir;
};

fs.mkdtemp = function patchedMkdtemp(prefix, options, callback) {
  if (typeof options === "function") {
    return originalMkdtemp.call(this, prefix, (error, dir) => {
      if (!error) trackTempDir(dir);
      options(error, dir);
    });
  }

  return originalMkdtemp.call(this, prefix, options, (error, dir) => {
    if (!error) trackTempDir(dir);
    callback(error, dir);
  });
};

if (originalPromisesMkdtemp) {
  fs.promises.mkdtemp = async function patchedPromisesMkdtemp(prefix, options) {
    const dir = await originalPromisesMkdtemp(prefix, options);
    trackTempDir(dir);
    return dir;
  };
}

syncBuiltinESMExports();

process.once("exit", cleanupCreatedDirs);
process.once("SIGINT", () => {
  cleanupCreatedDirs();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanupCreatedDirs();
  process.exit(143);
});

function trackTempDir(dir) {
  if (typeof dir !== "string") return;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`)) return;
  if (!path.basename(resolved).startsWith("nstack-")) return;
  createdDirs.add(resolved);
}

function cleanupCreatedDirs() {
  if (keepTemp) return;
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
