import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackageManagerDependencies } from "./package-manager.js";
import { fileExists } from "./util.js";

const pnpmVersion = "10.18.3";

export function hasSetupRunner(cwd) {
  return isNstackApp(cwd);
}

export function isNstackApp(cwd) {
  return fileExists(path.join(cwd, "nstack.config.mjs"))
    && fileExists(path.join(cwd, "package.json"));
}

export function runSetup(cwd, args = [], options = {}) {
  if (hasSetupRunner(cwd)) {
    const report = ensureLocalReady(cwd, {
      install: !hasFlag(args, "skip-install") && !hasFlag(args, "no-install") && !(options.skipInstall || options.noInstall),
      tools: !hasFlag(args, "skip-tools") && !hasFlag(args, "no-tools") && !(options.skipTools || options.noTools),
      docker: !hasFlag(args, "skip-docker") && !options.skipDocker,
    });
    console.log("nstack setup complete.");
    return { mode: "generated-app", ...report };
  }

  const report = runRepositorySetup(cwd, options);
  return { mode: "repository", ...report };
}

export function ensureLocalReady(cwd, options = {}) {
  ensureNode();
  ensurePnpm({ autoInstallTools: autoInstallTools(options) });
  const installedDependencies = options.install === false ? false : installDependenciesIfNeeded(cwd);
  const installedPlaywright = options.install === false ? false : ensurePlaywrightChromium(cwd);
  ensureEncoreCliIfNeeded(cwd, { autoInstallTools: autoInstallTools(options) });
  if (options.docker !== false && backendNeedsDocker(cwd)) ensureDockerReady();
  return {
    installedDependencies,
    installedPlaywright,
  };
}

function runRepositorySetup(cwd, options = {}) {
  ensureNode();
  ensurePnpm({ autoInstallTools: !skipToolInstall(options) });
  const installed = installDependenciesIfNeeded(cwd, options);
  ensureEncoreCliIfNeeded(cwd, { autoInstallTools: !skipToolInstall(options) });
  console.log("nstack setup complete.");
  return { installedDependencies: installed };
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return;
  fail([
    `Node.js ${process.version} is too old.`,
    "Install Node.js 22 or newer, then run this command again.",
  ]);
}

function ensurePnpm({ autoInstallTools }) {
  const result = runSync("pnpm", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return;
  if (autoInstallTools) {
    installPnpmWithCorepack();
    const retry = runSync("pnpm", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    if (retry.status === 0) return;
    fail([
      "Corepack finished, but pnpm is still not available on PATH.",
      ...commandDetail(retry).map((line) => `  ${line}`),
    ]);
  }
  fail([
    "pnpm is not available on PATH.",
    "Install pnpm with Corepack:",
    "  corepack enable",
    `  corepack prepare pnpm@${pnpmVersion} --activate`,
  ]);
}

function installPnpmWithCorepack() {
  const corepack = runSync("corepack", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (corepack.status !== 0) {
    fail([
      "pnpm is not available on PATH, and Corepack is missing.",
      `Install pnpm ${pnpmVersion} with Node.js 22 or newer, then run this command again.`,
      ...commandDetail(corepack).map((line) => `  ${line}`),
    ]);
  }
  console.log(`pnpm is missing; enabling Corepack and activating pnpm@${pnpmVersion}...`);
  const enable = runSync("corepack", ["enable"], { stdio: ["ignore", "pipe", "pipe"] });
  if (enable.status !== 0) {
    fail([
      "Corepack could not enable package-manager shims.",
      ...commandDetail(enable).map((line) => `  ${line}`),
    ]);
  }
  const prepare = runSync("corepack", ["prepare", `pnpm@${pnpmVersion}`, "--activate"], { stdio: ["ignore", "pipe", "pipe"] });
  if (prepare.status !== 0) {
    fail([
      `Corepack could not activate pnpm@${pnpmVersion}.`,
      ...commandDetail(prepare).map((line) => `  ${line}`),
    ]);
  }
}

function installDependenciesIfNeeded(cwd, options = {}) {
  if (options.skipInstall || options.noInstall) return false;
  if (!fileExists(path.join(cwd, "package.json"))) return false;
  if (!dependenciesMissing(cwd)) return false;
  console.log("Installing project dependencies...");
  return installPackageManagerDependencies({ name: "pnpm" }, { cwd });
}

function dependenciesMissing(cwd) {
  return !existsSync(path.join(cwd, "node_modules", ".modules.yaml"))
    || packageHasDependency(cwd, "playwright") && !existsSync(path.join(cwd, "node_modules", "playwright"))
    || existsSync(path.join(cwd, "backend", "package.json")) && !existsSync(path.join(cwd, "backend", "node_modules", "encore.dev"))
    || existsSync(path.join(cwd, "frontend", "package.json")) && !existsSync(path.join(cwd, "frontend", "node_modules", "nuxt"));
}

function ensurePlaywrightChromium(cwd) {
  if (!packageHasDependency(cwd, "playwright")) return false;
  const dryRun = runSync("pnpm", ["exec", "playwright", "install", "--dry-run", "chromium"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (dryRun.status !== 0) {
    fail([
      "Playwright is installed, but its browser installer could not run.",
      ...commandDetail(dryRun).map((line) => `  ${line}`),
    ]);
  }
  const locations = [...String(dryRun.stdout || "").matchAll(/Install location:\s+(.+)/g)]
    .map((match) => match[1].trim());
  if (locations.length > 0 && locations.every((location) => existsSync(location))) return false;
  console.log("Installing Playwright Chromium for devexec screenshots...");
  const install = runSync("pnpm", ["exec", "playwright", "install", "chromium"], { cwd });
  if (install.status !== 0) fail([`Playwright Chromium installation failed with exit code ${install.status || 1}.`]);
  return true;
}

function ensureEncoreCliIfNeeded(cwd, { autoInstallTools }) {
  if (!fileExists(path.join(cwd, "backend", "encore.app"))) return;
  const backendDir = path.join(cwd, "backend");
  const env = encoreEnv();
  const result = runSync("encore", ["version"], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    process.env.PATH = env.PATH;
    return;
  }
  if (autoInstallTools) {
    installEncoreCli();
    const retryEnv = encoreEnv();
    const retry = runSync("encore", ["version"], {
      cwd: backendDir,
      env: retryEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (retry.status === 0) {
      process.env.PATH = retryEnv.PATH;
      return;
    }
    fail([
      "Encore CLI installation completed, but encore is still not available on PATH.",
      ...commandDetail(retry).map((line) => `  ${line}`),
    ]);
  }
  fail([
    "The Encore CLI is not available on PATH.",
    "nstack uses Encore locally for metadata, codegen, and the dev server.",
    "Install it, then run this command again:",
    "  macOS:      brew install encoredev/tap/encore",
    "  Linux/WSL:  curl -L https://encore.dev/install.sh | bash",
    "  Windows:    iwr https://encore.dev/install.ps1 | iex",
  ]);
}

function installEncoreCli() {
  if (process.platform === "win32") {
    fail([
      "The Encore CLI is not available on PATH.",
      "Install it in PowerShell, then run this command again:",
      "  iwr https://encore.dev/install.ps1 | iex",
    ]);
  }
  const curl = runSync("curl", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (curl.status !== 0) {
    fail([
      "The Encore CLI is not available on PATH, and curl is missing.",
      "Install curl or install the Encore CLI manually, then run this command again:",
      "  curl -fsSL https://encore.dev/install.sh | bash",
    ]);
  }
  console.log("Encore CLI is missing; installing it with the official Encore installer...");
  const install = runSync("bash", ["-lc", "curl -fsSL https://encore.dev/install.sh | bash"], {
    env: encoreEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    fail([
      "The Encore CLI installer failed.",
      ...commandDetail(install).map((line) => `  ${line}`),
    ]);
  }
}

function ensureDockerReady() {
  const result = runSync("docker", ["info"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return;
  const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(0, 4);
  fail([
    "Docker is not running or this user cannot access the Docker daemon.",
    "Encore local development needs Docker for declared databases, caches, Pub/Sub, and object storage.",
    "Start Docker Desktop or the Docker daemon, fix Docker permissions if needed, then run this command again.",
    ...detail.map((line) => `  ${line}`),
  ]);
}

function backendNeedsDocker(cwd) {
  for (const file of sourceFiles(path.join(cwd, "backend"))) {
    const text = readFileSync(file, "utf8");
    if (/\bnew\s+(?:SQLDatabase|CacheCluster|Topic|Bucket)\s*\(/.test(text)) return true;
  }
  return false;
}

function sourceFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", ".encore", "encore.gen", ".turbo", ".cache"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && /\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function packageHasDependency(cwd, name) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: options.encoding || "utf8",
    stdio: options.stdio || "inherit",
    shell: process.platform === "win32",
  });
}

function skipToolInstall(options = {}) {
  return Boolean(options.skipTools || options.noTools)
    || ["0", "false", "off", "no"].includes(String(process.env.NSTACK_AUTO_INSTALL_TOOLS || "").trim().toLowerCase());
}

function autoInstallTools(options = {}) {
  if (options.tools === false) return false;
  return !skipToolInstall(options);
}

function encoreEnv() {
  return {
    ...process.env,
    PATH: encorePath(),
    ENCORE_TELEMETRY_DISABLED: process.env.ENCORE_TELEMETRY_DISABLED || "1",
  };
}

function encorePath() {
  return [
    process.env.PATH || "",
    path.join(os.homedir(), ".encore", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ].filter(Boolean).join(path.delimiter);
}

function commandDetail(result) {
  return String(result?.error?.message || result?.stderr || result?.stdout || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function fail(lines) {
  throw new Error(lines.join("\n"));
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}
