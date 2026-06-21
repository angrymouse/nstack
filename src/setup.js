import os from "node:os";
import path from "node:path";
import { installPackageManagerDependencies } from "./package-manager.js";
import { fileExists, run } from "./util.js";

const setupScript = "scripts/nstack-local.mjs";
const pnpmVersion = "10.18.3";

export function hasSetupRunner(cwd) {
  return fileExists(path.join(cwd, setupScript));
}

export function runSetup(cwd, args = [], options = {}) {
  if (hasSetupRunner(cwd)) {
    run(process.execPath, [setupScript, "setup", ...setupArgs(args, options)], {
      cwd,
      capture: Boolean(options.capture),
    });
    return { mode: "generated-app", script: setupScript };
  }

  const report = runRepositorySetup(cwd, options);
  return { mode: "repository", ...report };
}

function setupArgs(args = [], options = {}) {
  const out = [];
  if (options.skipInstall || options.noInstall) out.push("--skip-install");
  if (options.skipTools || options.noTools) out.push("--skip-tools");
  if (options.skipDocker) out.push("--skip-docker");
  out.push(...args);
  return out;
}

function runRepositorySetup(cwd, options = {}) {
  ensureNode();
  ensurePnpm({ autoInstallTools: !skipToolInstall(options) });
  const installed = installDependenciesIfNeeded(cwd, options);
  ensureEncoreIfNeeded(cwd, { autoInstallTools: !skipToolInstall(options) });
  console.log("nstack setup complete.");
  return { installedDependencies: installed };
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return;
  throw new Error(`Node.js ${process.version} is too old. Install Node.js 22 or newer, then rerun nstack setup.`);
}

function ensurePnpm({ autoInstallTools }) {
  if (commandOk("pnpm", ["--version"])) return;
  if (!autoInstallTools) {
    throw new Error(`pnpm is not available on PATH. Run corepack enable && corepack prepare pnpm@${pnpmVersion} --activate.`);
  }

  if (!commandOk("corepack", ["--version"])) {
    throw new Error(`pnpm is not available and Corepack is missing. Install pnpm ${pnpmVersion} with Node.js 22, then rerun nstack setup.`);
  }

  console.log(`pnpm is missing; enabling Corepack and activating pnpm@${pnpmVersion}...`);
  run("corepack", ["enable"], { capture: true });
  run("corepack", ["prepare", `pnpm@${pnpmVersion}`, "--activate"], { capture: true });
  if (!commandOk("pnpm", ["--version"])) throw new Error("Corepack completed, but pnpm is still not available on PATH.");
}

function installDependenciesIfNeeded(cwd, options = {}) {
  if (options.skipInstall || options.noInstall) return false;
  if (!fileExists(path.join(cwd, "package.json"))) return false;
  installPackageManagerDependencies({ name: "pnpm" }, { cwd });
  return true;
}

function ensureEncoreIfNeeded(cwd, { autoInstallTools }) {
  if (!fileExists(path.join(cwd, "backend", "encore.app"))) return;
  if (commandOk("encore", ["version"], { cwd: path.join(cwd, "backend"), env: encoreEnv() })) return;
  if (!autoInstallTools) {
    throw new Error("The Encore CLI is not available on PATH. Install it from https://encore.dev/docs/ts/install, then rerun nstack setup.");
  }
  installEncoreCli();
  if (!commandOk("encore", ["version"], { cwd: path.join(cwd, "backend"), env: encoreEnv() })) {
    throw new Error("Encore CLI installation completed, but encore is still not available on PATH.");
  }
}

function installEncoreCli() {
  if (process.platform === "win32") {
    throw new Error("Install the Encore CLI in PowerShell with: iwr https://encore.dev/install.ps1 | iex");
  }
  if (!commandOk("curl", ["--version"])) {
    throw new Error("The Encore CLI is missing and curl is not available. Install curl, then rerun nstack setup.");
  }
  console.log("Encore CLI is missing; installing it with the official Encore installer...");
  run("bash", ["-lc", "curl -fsSL https://encore.dev/install.sh | bash"], {
    capture: true,
    env: encoreEnv(),
  });
}

function commandOk(command, args, options = {}) {
  const result = run(command, args, {
    cwd: options.cwd,
    env: options.env,
    capture: true,
    allowFailure: true,
  });
  return result.status === 0;
}

function skipToolInstall(options = {}) {
  return Boolean(options.skipTools || options.noTools)
    || ["0", "false", "off", "no"].includes(String(process.env.NSTACK_AUTO_INSTALL_TOOLS || "").trim().toLowerCase());
}

function encoreEnv() {
  return {
    ...process.env,
    PATH: encorePath(),
    ENCORE_TELEMETRY_DISABLED: process.env.ENCORE_TELEMETRY_DISABLED || "1",
  };
}

function encorePath() {
  const additions = [
    process.env.PATH || "",
    path.join(os.homedir(), ".encore", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ];
  return additions.filter(Boolean).join(path.delimiter);
}
