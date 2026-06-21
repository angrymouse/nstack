import path from "node:path";
import { aiDevServerAllowed, detectAgentHarness, devServerGuardMessage } from "./harness.js";
import { fileExists, run } from "./util.js";

const devScript = "scripts/dev.mjs";
const devExecScript = "scripts/devexec.mjs";

export function hasDevRunner(cwd) {
  return fileExists(path.join(cwd, devScript));
}

export function hasDevExecRunner(cwd) {
  return fileExists(path.join(cwd, devExecScript));
}

export function runDev(cwd, args = [], options = {}) {
  if (!hasDevRunner(cwd)) {
    throw new Error("nstack dev requires a generated app with scripts/dev.mjs. Run it from an nstack app root or pass --cwd <app>.");
  }
  const harness = detectAgentHarness();
  if (harness.detected && !aiDevServerAllowed()) {
    throw new Error(devServerGuardMessage(harness));
  }
  run(process.execPath, [devScript, ...args], {
    cwd,
    capture: Boolean(options.capture),
  });
  return { script: devScript, harness };
}

export function runDevExec(cwd, args = [], options = {}) {
  if (!hasDevExecRunner(cwd)) {
    throw new Error("nstack devexec requires a generated app with scripts/devexec.mjs. Run it from an updated nstack app root or pass --cwd <app>.");
  }
  const harness = detectAgentHarness();
  run(process.execPath, [devExecScript, ...devExecArgs(args, options)], {
    cwd,
    capture: Boolean(options.capture),
  });
  return { script: devExecScript, harness };
}

function devExecArgs(args = [], options = {}) {
  const out = [];
  addValue(out, "code", options.code);
  addValue(out, "file", options.file);
  addValue(out, "base-url", options.baseUrl);
  addValue(out, "frontend-url", options.frontendUrl);
  addValue(out, "backend-url", options.backendUrl);
  addValue(out, "api-url", options.apiUrl);
  addValue(out, "wait-url", options.waitUrl);
  addValue(out, "timeout-ms", options.timeoutMs);
  out.push(...args);
  return out;
}

function addValue(args, key, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(`--${key}`, String(value));
}
