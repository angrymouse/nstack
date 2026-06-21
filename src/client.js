import path from "node:path";
import { fileExists, run } from "./util.js";

const clientScript = "scripts/nstack-client.mjs";
const clientModes = new Set(["gen", "check", "watch", "bench", "benchmark"]);

export function hasClientGenerator(cwd) {
  return fileExists(path.join(cwd, clientScript));
}

export function runClientGenerator(cwd, mode = "gen", options = {}) {
  if (!hasClientGenerator(cwd)) return { skipped: true };
  const normalized = mode || "gen";
  if (!clientModes.has(normalized)) {
    throw new Error(`Unknown nstack client command: ${normalized}`);
  }
  const args = [clientScript, normalized];
  if (options.force) args.push("--force");
  run(process.execPath, args, {
    cwd,
    capture: Boolean(options.capture),
  });
  return { skipped: false, mode: normalized };
}

export function clientGeneratorPath() {
  return clientScript;
}
