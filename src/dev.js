import path from "node:path";
import { fileExists, run } from "./util.js";

const devScript = "scripts/dev.mjs";

export function hasDevRunner(cwd) {
  return fileExists(path.join(cwd, devScript));
}

export function runDev(cwd, args = [], options = {}) {
  if (!hasDevRunner(cwd)) {
    throw new Error("nstack dev requires a generated app with scripts/dev.mjs. Run it from an nstack app root or pass --cwd <app>.");
  }
  run(process.execPath, [devScript, ...args], {
    cwd,
    capture: Boolean(options.capture),
  });
  return { script: devScript };
}
