import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shell = process.platform === "win32";

const disabledHarnessValues = new Set(["0", "false", "off", "no", "none", ""]);

const harnessChecks = [
  {
    name: "codex",
    label: "Codex",
    markers: ["CODEX_CI", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_PACKAGE_ROOT"],
  },
  {
    name: "claude-code",
    label: "Claude Code",
    markers: ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"],
  },
  {
    name: "paseo",
    label: "Paseo",
    markers: ["PASEO_AGENT_ID"],
  },
  {
    name: "opencode",
    label: "OpenCode",
    markers: ["OPENCODE", "OPENCODE_SESSION_ID"],
  },
  {
    name: "cursor",
    label: "Cursor",
    markers: ["CURSOR_AGENT", "CURSOR_TRACE_ID"],
  },
  {
    name: "windsurf",
    label: "Windsurf",
    markers: ["WINDSURF", "WINDSURF_SESSION_ID"],
  },
];

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

export function detectAgentHarness(env = process.env) {
  const override = String(env.NSTACK_AGENT_HARNESS || "").trim();
  if (override) {
    const normalized = override.toLowerCase();
    if (disabledHarnessValues.has(normalized)) return noHarness();
    return {
      detected: true,
      name: slugHarnessName(override),
      label: labelHarnessName(override),
      markers: ["NSTACK_AGENT_HARNESS"],
    };
  }

  for (const check of harnessChecks) {
    const markers = check.markers.filter((marker) => Boolean(env[marker]));
    if (markers.length > 0) {
      return {
        detected: true,
        name: check.name,
        label: check.label,
        markers,
      };
    }
  }

  return noHarness();
}

export function agentHarnessNotice(harness = detectAgentHarness()) {
  if (!harness.detected) return "";
  return devServerGuardMessage(harness);
}

export function aiDevServerAllowed(env = process.env) {
  return String(env.AI_ALLOW_DEVSERVER || "").trim() === "1";
}

export function devServerGuardMessage(harness = detectAgentHarness()) {
  if (!harness.detected) return "";
  return [
    `nstack dev detected ${harness.label}.`,
    "For AI harnesses, starting a long-running dev server just to inspect state and then issue requests is a bad idea.",
    "Use `nstack devexec '<js>'` for one-shot checks; it starts the dev stack, runs your JavaScript, then shuts it down.",
    "If you truly need an interactive dev server, set AI_ALLOW_DEVSERVER=1 and rerun `nstack dev`.",
  ].join(" ");
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

function noHarness() {
  return {
    detected: false,
    name: null,
    label: null,
    markers: [],
  };
}

function slugHarnessName(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "agent";
}

function labelHarnessName(value) {
  return String(value || "agent")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "agent";
}
