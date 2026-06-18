import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

export function fileExists(file) {
  return existsSync(file);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJSON(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, value);
}

export function readText(file, fallback = "") {
  return existsSync(file) ? readFileSync(file, "utf8") : fallback;
}

export function copyTree(from, to, replacements = {}) {
  const stat = statSync(from);
  if (stat.isDirectory()) {
    ensureDir(to);
    for (const entry of readdirSync(from)) {
      copyTree(path.join(from, entry), path.join(to, entry), replacements);
    }
    return;
  }

  if (!stat.isFile()) return;
  ensureDir(path.dirname(to));
  if (isTemplateTextFile(from)) {
    let text = readFileSync(from, "utf8");
    for (const [key, value] of Object.entries(replacements)) {
      text = text.replaceAll(`__${key}__`, String(value));
    }
    writeFileSync(to, text);
    return;
  }
  copyFileSync(from, to);
}

function isTemplateTextFile(file) {
  return /\.(json|mjs|js|ts|vue|md|yml|yaml|sql|gitignore|env|txt|toml|Dockerfile)$/.test(file)
    || path.basename(file).startsWith(".");
}

export function removeIfExists(target) {
  rmSync(target, { recursive: true, force: true });
}

export function slugify(input) {
  return String(input || "app")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "app";
}

export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.error?.message || result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.error?.message || (options.capture ? (result.stderr || result.stdout || "").trim() : "")).trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

export function parseDotEnv(text) {
  const env = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = parseEnvValue(match[2].trim());
  }
  return env;
}

function parseEnvValue(raw) {
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

export function formatDotEnv(env) {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return `${entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteEnv(value)}`)
    .join("\n")}\n`;
}

function quoteEnv(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

export function mergeEnvFile(file, values) {
  const current = parseDotEnv(readText(file, ""));
  writeText(file, formatDotEnv({ ...current, ...values }));
}

export function findUp(filename, start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

export function idOf(value, names = ["id"]) {
  for (const name of names) {
    if (value && typeof value[name] === "string" && value[name]) return value[name];
  }
  return "";
}
