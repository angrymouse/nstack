import os from "node:os";
import path from "node:path";
import { commandOutput, readJSON, writeJSON } from "./util.js";

const schemaVersion = 1;
const supportedPackageManagers = ["pnpm"];

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
      { command: "pnpm", args: ["approve-builds", "--all"], label: "pnpm approve-builds --all" },
    ];
  }
  throw unsupportedPackageManagerError(name);
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

function normalizePackageManager(value = "") {
  return String(value || "").trim().toLowerCase();
}

function unsupportedPackageManagerError(packageManager) {
  return new Error(`Unsupported package manager for this template: ${packageManager || "(missing)"}. Supported: ${supportedPackageManagers.join(", ")}.`);
}
