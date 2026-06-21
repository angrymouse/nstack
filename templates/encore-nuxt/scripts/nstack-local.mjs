import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shell = process.platform === "win32";

export async function ensureLocalReady(options = {}) {
  ensureNode();
  ensurePnpm();
  if (options.install !== false) installDependenciesIfNeeded();
  ensureEncoreCli();
  if (options.docker !== false && backendNeedsDocker()) ensureDockerReady();
}

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: options.stdio || "inherit",
      shell,
    });
    child.on("close", (code) => resolve(code || 0));
    child.on("error", () => resolve(1));
  });
}

export function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: options.encoding || "utf8",
    stdio: options.stdio || "inherit",
    shell,
  });
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return;
  fail([
    `Node.js ${process.version} is too old.`,
    "Install Node.js 22 or newer, then run this command again.",
  ]);
}

function ensurePnpm() {
  const result = runSync("pnpm", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return;
  fail([
    "pnpm is not available on PATH.",
    "Install pnpm with Corepack:",
    "  corepack enable",
    "  corepack prepare pnpm@10.18.3 --activate",
  ]);
}

function installDependenciesIfNeeded() {
  if (!dependenciesMissing()) return;
  console.log("Installing project dependencies...");
  const install = runSync("pnpm", ["install", "--no-frozen-lockfile"]);
  if (install.status !== 0) process.exit(install.status || 1);
  approvePnpmBuilds();
}

function dependenciesMissing() {
  return !existsSync(path.join(root, "node_modules", ".modules.yaml"))
    || !existsSync(path.join(root, "backend", "node_modules", "encore.dev"))
    || !existsSync(path.join(root, "frontend", "node_modules", "nuxt"));
}

function approvePnpmBuilds() {
  const help = runSync("pnpm", ["help", "approve-builds"], { stdio: ["ignore", "pipe", "pipe"] });
  const text = `${help.stdout || ""}\n${help.stderr || ""}`;
  if (help.status !== 0 || !text.includes("--all")) return;
  const approve = runSync("pnpm", ["approve-builds", "--all"]);
  if (approve.status !== 0) process.exit(approve.status || 1);
}

function ensureEncoreCli() {
  const result = runSync("encore", ["version"], { cwd: path.join(root, "backend"), stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return;
  fail([
    "The Encore CLI is not available on PATH.",
    "nstack uses Encore locally for metadata, codegen, and the dev server; Encore Cloud login is not required.",
    "Install it, then run this command again:",
    "  macOS:      brew install encoredev/tap/encore",
    "  Linux/WSL:  curl -L https://encore.dev/install.sh | bash",
    "  Windows:    iwr https://encore.dev/install.ps1 | iex",
  ]);
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

function backendNeedsDocker() {
  for (const file of sourceFiles(path.join(root, "backend"))) {
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

function fail(lines) {
  console.error(lines.join("\n"));
  process.exit(1);
}
