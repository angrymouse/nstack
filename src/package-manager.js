import os from "node:os";
import path from "node:path";
import { commandOutput, readJSON, readText, run, writeJSON, writeText } from "./util.js";

const schemaVersion = 1;
const supportedPackageManagers = ["pnpm"];
const defaultPnpmVersion = "10.18.3";

export const packageManagerEnv = "NSTACK_PACKAGE_MANAGER";
export const rememberPackageManagerEnv = "NSTACK_REMEMBER_PACKAGE_MANAGER";

export function settingsPath() {
  if (process.env.NSTACK_SETTINGS_FILE) return process.env.NSTACK_SETTINGS_FILE;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "nstack", "settings.json");
}

export function loadDefaultPackageManager(file = settingsPath()) {
  const value = readJSON(file, {})?.packageManager || "";
  return supportedPackageManagers.includes(value) ? value : "";
}

export function saveDefaultPackageManager(packageManager, file = settingsPath()) {
  const normalized = normalizePackageManager(packageManager);
  if (!supportedPackageManagers.includes(normalized)) throw unsupportedPackageManagerError(packageManager);
  const settings = readJSON(file, {});
  writeJSON(file, { version: schemaVersion, ...settings, packageManager: normalized });
  return normalized;
}

export async function promptPackageManager(prompter, {
  requested = "",
  file = settingsPath(),
  requireAvailable = true,
} = {}) {
  if (requireAvailable) bootstrapPnpmWithCorepack();
  const explicit = normalizePackageManager(requested || process.env[packageManagerEnv] || "");
  if (explicit) return resolvePackageManager(explicit, { requireAvailable });

  const saved = loadDefaultPackageManager(file);
  const available = availablePackageManagers();
  if (requireAvailable && available.length === 0) {
    throw new Error("pnpm is required to initialize this template. Install pnpm or rerun with --skip-install.");
  }

  const defaultValue = saved && available.some((item) => item.name === saved)
    ? saved
    : available[0]?.name || saved || "pnpm";

  if (available.length === 0) return resolvePackageManager(defaultValue, { requireAvailable: false });
  if (prompter.yes) return resolvePackageManager(defaultValue, { requireAvailable });

  const choices = available.map((item) => ({
    label: `${item.name}${item.version ? ` ${item.version}` : ""}`,
    value: item.name,
    packageManager: item,
  }));
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue));
  const selected = await prompter.select(packageManagerEnv, "Package manager", choices, { defaultIndex });
  const packageManager = selected.packageManager || resolvePackageManager(selected.value, { requireAvailable });
  const shouldRemember = await prompter.confirm(
    rememberPackageManagerEnv,
    `Remember ${packageManager.name} as default package manager for new projects?`,
    { defaultValue: true },
  );
  if (shouldRemember) saveDefaultPackageManager(packageManager.name, file);
  return packageManager;
}

export function packageManagerInstallCommands(packageManager) {
  const name = normalizePackageManager(packageManager?.name || packageManager);
  if (name === "pnpm") {
    return [
      { command: "pnpm", args: ["install", "--no-frozen-lockfile"], label: "pnpm install --no-frozen-lockfile" },
      { command: "pnpm", args: ["approve-builds"], label: "pnpm approve-builds" },
    ];
  }
  throw unsupportedPackageManagerError(name);
}

export function installPackageManagerDependencies(packageManager, { cwd = process.cwd() } = {}) {
  const name = normalizePackageManager(packageManager?.name || packageManager);
  if (name !== "pnpm") throw unsupportedPackageManagerError(name);

  const labels = ["pnpm install --no-frozen-lockfile"];
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd, capture: true });
  labels.push(...approvePnpmBuilds(cwd));
  return labels;
}

function approvePnpmBuilds(cwd) {
  if (pnpmApproveBuildsSupportsAll(cwd)) {
    run("pnpm", ["approve-builds", "--all"], { cwd, capture: true });
    return ["pnpm approve-builds --all"];
  }

  const ignored = pnpmIgnoredBuilds(cwd);
  if (ignored.length === 0) return ["pnpm ignored-builds"];
  approvePnpmWorkspaceBuilds(cwd, ignored);
  run("pnpm", ["rebuild"], { cwd, capture: true });
  return ["pnpm ignored-builds", "pnpm rebuild"];
}

function pnpmApproveBuildsSupportsAll(cwd) {
  try {
    return /^\s*--all\b/m.test(commandOutput("pnpm", ["help", "approve-builds"], { cwd }));
  } catch {
    return false;
  }
}

function pnpmIgnoredBuilds(cwd) {
  const output = commandOutput("pnpm", ["ignored-builds"], { cwd });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => (
      line &&
      line !== "None" &&
      !line.endsWith(":") &&
      !line.startsWith("hint:")
    ));
}

function approvePnpmWorkspaceBuilds(cwd, packages) {
  const workspaceFile = path.join(cwd, "pnpm-workspace.yaml");
  const unique = [...new Set(packages.map(String).filter(Boolean))].sort();
  const current = readText(workspaceFile, "");
  writeText(workspaceFile, updateYamlList(current, "onlyBuiltDependencies", unique));
}

function updateYamlList(text, key, values) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const start = lines.findIndex((line) => line.trim() === `${key}:` && !/^\s/.test(line));
  const current = start === -1 ? [] : readYamlList(lines, start);
  const merged = [...new Set([...current, ...values])].sort();
  const replacement = [`${key}:`, ...merged.map((value) => `  - ${yamlScalar(value)}`)];

  if (start === -1) {
    if (lines.length > 0) lines.push("");
    lines.push(...replacement);
    return `${lines.join("\n")}\n`;
  }

  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end].trim() === "")) end += 1;
  lines.splice(start, end - start, ...replacement);
  return `${lines.join("\n")}\n`;
}

function readYamlList(lines, start) {
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s/.test(line) && line.trim()) break;
    const match = line.match(/^\s*-\s+(.+?)\s*$/);
    if (match) values.push(unquoteYamlScalar(match[1]));
  }
  return values;
}

function yamlScalar(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text);
}

function unquoteYamlScalar(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

export function availablePackageManagers() {
  return supportedPackageManagers
    .map((name) => ({ name, version: packageManagerVersion(name) }))
    .filter((item) => item.version);
}

function resolvePackageManager(name, { requireAvailable }) {
  const normalized = normalizePackageManager(name);
  if (!supportedPackageManagers.includes(normalized)) throw unsupportedPackageManagerError(name);
  const version = packageManagerVersion(normalized);
  if (requireAvailable && !version) {
    throw new Error(`${normalized} is not available on PATH. Install ${normalized} or rerun with --skip-install.`);
  }
  return { name: normalized, version };
}

function packageManagerVersion(name) {
  try {
    return commandOutput(name, ["--version"]).trim().split(/\s+/)[0] || "";
  } catch {
    return "";
  }
}

function bootstrapPnpmWithCorepack() {
  if (packageManagerVersion("pnpm")) return;
  if (toolBootstrapDisabled()) return;
  try {
    commandOutput("corepack", ["--version"]);
    console.log(`pnpm is missing; enabling Corepack and activating pnpm@${defaultPnpmVersion}...`);
    run("corepack", ["enable"], { capture: true });
    run("corepack", ["prepare", `pnpm@${defaultPnpmVersion}`, "--activate"], { capture: true });
  } catch {
    // promptPackageManager will raise the normal pnpm-required error below.
  }
}

function toolBootstrapDisabled() {
  return ["0", "false", "off", "no"].includes(String(process.env.NSTACK_AUTO_INSTALL_TOOLS || "").trim().toLowerCase());
}

function normalizePackageManager(value = "") {
  return String(value || "").trim().toLowerCase();
}

function unsupportedPackageManagerError(packageManager) {
  return new Error(`Unsupported package manager for this template: ${packageManager || "(missing)"}. Supported: ${supportedPackageManagers.join(", ")}.`);
}
