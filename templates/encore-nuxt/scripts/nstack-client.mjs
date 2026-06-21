#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.join(root, "backend");
const clientFile = path.join(root, "frontend", "app", "generated", "encore-client.ts");
const cacheFile = path.join(root, ".nstack", "client.json");
const tempRoot = path.join(root, ".nstack", "tmp");
const mode = process.argv[2] || "gen";
const ignoredDirs = new Set(["node_modules", ".encore", "encore.gen", ".turbo", ".cache", "dist", "coverage"]);
const watchedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".sql"]);
const postprocessVersion = "nstack-dokploy-env-v1";
const activeTempDirs = new Set();
let tempCleanupAt = 0;
let tempSignalHandlersInstalled = false;

if (mode === "gen") {
  process.exit(ensureClient({ force: process.argv.includes("--force") }));
}

if (mode === "check") {
  process.exit(checkClient());
}

if (mode === "watch") {
  process.exit(await watchClient());
}

if (mode === "bench" || mode === "benchmark") {
  process.exit(benchmarkClient());
}

console.error(`Unknown nstack client mode: ${mode}`);
process.exit(1);

function ensureClient(options = {}) {
  const signature = clientSignature();
  if (!options.force && options.output === undefined && cacheMatches(signature)) return 0;

  const started = performance.now();
  const tempDir = makeTempDir("client");
  const raw = path.join(tempDir, "raw-client.ts");
  try {
    const code = generateRawClient(raw, options);
    if (code !== 0) return code;
    const text = postprocessClient(readFileSync(raw, "utf8"));
    const output = options.output || clientFile;
    mkdirSync(path.dirname(output), { recursive: true });
    const changed = options.output || !existsSync(output) || readFileSync(output, "utf8") !== text;
    if (changed) writeFileAtomic(output, text);
    if (!options.output) writeClientCache(signature, hashText(text));
    if (!options.quiet) {
      const ms = Math.round(performance.now() - started);
      if (changed) console.log(`Encore client generated in ${ms}ms.`);
      else if (!options.quietUnchanged) console.log(`Encore client already up to date in ${ms}ms.`);
    }
    return 0;
  } finally {
    removeTempDir(tempDir);
  }
}

function generateRawClient(output, options = {}) {
  mkdirSync(path.dirname(output), { recursive: true });
  const result = runEncore(["gen", "client", "--env=local", "--output", output], { quiet: true });
  if (result.status === 0) return 0;

  if (!options.quiet) console.log("Preparing Encore API metadata for client generation...");
  const check = runEncore(["check"], { quiet: options.quiet });
  if (check.status === 0) {
    const retry = runEncore(["gen", "client", "--env=local", "--output", output], { quiet: options.quiet });
    if (retry.status === 0) return 0;
    return reportGenerationFailure(retry, { check });
  }

  return reportGenerationFailure(result, { check });
}

function runEncore(args, options = {}) {
  return spawnSync("encore", args, {
    cwd: backendDir,
    encoding: "utf8",
    env: encoreEnv(),
    shell: process.platform === "win32",
    stdio: options.quiet ? "pipe" : "inherit",
  });
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

function reportGenerationFailure(result, details = {}) {
  const detail = commandDetail(result);
  const checkDetail = commandDetail(details.check);
  console.error("Failed to generate the Encore client.");
  if (detail) console.error(detail);
  if (checkDetail) {
    console.error("Encore metadata preparation also failed:");
    console.error(checkDetail);
  }
  console.error("nstack generates the client from local Encore metadata; Encore Cloud login is not required.");
  console.error("Install dependencies and the Encore CLI, then run `pnpm check` or `nstack client gen` again.");
  return result?.status || 1;
}

function commandDetail(result) {
  if (!result) return "";
  return [
    result.error?.message,
    result.stderr,
    result.stdout,
  ].filter(Boolean).join("\n").trim();
}

function checkClient() {
  const tempDir = makeTempDir("client-check");
  const generated = path.join(tempDir, "encore-client.ts");
  try {
    const code = ensureClient({ output: generated, quiet: true, force: true });
    if (code !== 0) return code;

    if (!existsSync(clientFile)) {
      console.error("The generated Encore client is missing. Run `pnpm check` or `nstack client gen`.");
      return 1;
    }

    const expected = readFileSync(generated, "utf8");
    const current = readFileSync(clientFile, "utf8");
    if (current !== expected) {
      console.error("The generated Encore client is out of date. Run `pnpm check` or `nstack client gen`.");
      return 1;
    }
    return 0;
  } finally {
    removeTempDir(tempDir);
  }
}

async function watchClient() {
  let signature = snapshotBackend();
  let generating = false;
  let queued = false;

  const run = () => {
    if (generating) {
      queued = true;
      return;
    }
    generating = true;
    ensureClient({ force: true, quietUnchanged: true });
    generating = false;
    if (queued) {
      queued = false;
      run();
    }
  };

  run();
  const intervalMs = watchIntervalMs();
  setInterval(() => {
    const next = snapshotBackend();
    if (next === signature) return;
    signature = next;
    run();
  }, intervalMs);

  await new Promise(() => {});
  return 0;
}

function watchIntervalMs() {
  const value = Number(process.env.NSTACK_CLIENT_WATCH_INTERVAL_MS || 500);
  return Number.isFinite(value) ? Math.max(100, value) : 500;
}

function benchmarkClient() {
  const runs = Number(process.env.NSTACK_CLIENT_BENCH_RUNS || 3);
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const tempDir = makeTempDir("client-bench");
    const output = path.join(tempDir, "encore-client.ts");
    const started = performance.now();
    try {
      const code = ensureClient({ output, quiet: true, force: true });
      if (code !== 0) return code;
      times.push(Math.round(performance.now() - started));
    } finally {
      removeTempDir(tempDir);
    }
  }
  const average = Math.round(times.reduce((sum, value) => sum + value, 0) / times.length);
  console.log(JSON.stringify({ runs: times.length, timesMs: times, averageMs: average }, null, 2));
  return 0;
}

function makeTempDir(prefix) {
  cleanupStaleTempDirs();
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, `${prefix}-${process.pid}-`));
  activeTempDirs.add(dir);
  installTempCleanupHandlers();
  return dir;
}

function removeTempDir(dir) {
  activeTempDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

function cleanupStaleTempDirs() {
  const now = Date.now();
  if (now - tempCleanupAt < 60_000) return;
  tempCleanupAt = now;
  mkdirSync(tempRoot, { recursive: true });
  const ttlMs = tempTtlMs();
  for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^client(?:-check|-bench)?-/.test(entry.name)) continue;
    const full = path.join(tempRoot, entry.name);
    try {
      const ownerPid = tempOwnerPid(entry.name);
      const ownerExited = ownerPid > 0 && ownerPid !== process.pid && !processIsRunning(ownerPid);
      if (ownerExited || now - statSync(full).mtimeMs >= ttlMs) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Another process may have removed the temp directory first.
    }
  }
}

function tempTtlMs() {
  const value = Number(process.env.NSTACK_CLIENT_TEMP_TTL_MS || 60 * 60 * 1000);
  return Number.isFinite(value) ? Math.max(60_000, value) : 60 * 60 * 1000;
}

function tempOwnerPid(name) {
  const match = name.match(/^client(?:-check|-bench)?-(\d+)-/);
  return match ? Number(match[1]) : 0;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function installTempCleanupHandlers() {
  if (tempSignalHandlersInstalled) return;
  tempSignalHandlersInstalled = true;
  process.once("exit", cleanupActiveTempDirs);
  process.once("SIGINT", () => {
    cleanupActiveTempDirs();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanupActiveTempDirs();
    process.exit(143);
  });
}

function cleanupActiveTempDirs() {
  for (const dir of [...activeTempDirs]) removeTempDir(dir);
}

function snapshotBackend() {
  return listWatchedFiles(backendDir)
    .map((file) => {
      const stat = statSync(file);
      return `${path.relative(backendDir, file)}:${stat.size}:${stat.mtimeMs}`;
    })
    .sort()
    .join("\n");
}

function listWatchedFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listWatchedFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "encore.app" || watchedExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function clientSignature() {
  const hash = createHash("sha256");
  hash.update(`${postprocessVersion}\n`);
  hash.update(`${encoreVersion()}\n`);
  for (const file of listWatchedFiles(backendDir).sort()) {
    hash.update(path.relative(backendDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cacheMatches(signature) {
  if (!existsSync(clientFile) || !existsSync(cacheFile)) return false;
  try {
    const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    return cache.signature === signature && cache.clientHash === hashFile(clientFile);
  } catch {
    return false;
  }
}

function writeClientCache(signature, clientHash) {
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify({ signature, clientHash }, null, 2)}\n`);
}

function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function encoreVersion() {
  const result = spawnSync("encore", ["version"], {
    cwd: backendDir,
    encoding: "utf8",
    env: encoreEnv(),
    shell: process.platform === "win32",
  });
  return result.status === 0 ? result.stdout.trim() : "encore-version-unavailable";
}

function hashFile(file) {
  return hashText(readFileSync(file, "utf8"));
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function postprocessClient(text) {
  const pattern = /\/\*\*\n \* Environment returns[\s\S]*?export function PreviewEnv\(pr: number \| string\): BaseURL \{\n    return Environment\(`pr\$\{pr\}`\)\n\}/;
  const next = withStableClientAppName(text.replace(pattern, nstackEnvironmentBlock()));
  if (next === text) throw new Error("Could not patch Encore client environment helpers.");
  if (next.includes(".encr.app")) throw new Error("Generated client still contains Encore Cloud environment URLs.");
  return next;
}

function withStableClientAppName(text) {
  const name = clientAppName();
  return text
    .replace(
      /Client is an API client for the .+? Encore application\./,
      `Client is an API client for the ${name} Encore application.`,
    )
    .replace(
      /this\.headers\["User-Agent"\] = ".+?-Generated-TS-Client \(Encore\/([^"]+)\)";/,
      `this.headers["User-Agent"] = "${name}-Generated-TS-Client (Encore/$1)";`,
    );
}

function clientAppName() {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name || "nstack";
  } catch {
    return "nstack";
  }
}

function nstackEnvironmentBlock() {
  return `/**
 * Environment returns a BaseURL for an nstack/Dokploy target.
 */
export function Environment(name: string): BaseURL {
    return nstackEnvironment(name)
}

/**
 * PreviewEnv returns a BaseURL for an nstack/Dokploy preview target like "pr12".
 */
export function PreviewEnv(pr: number | string): BaseURL {
    return nstackEnvironment(\`pr\${pr}\`)
}

/**
 * NstackEnvironment returns a BaseURL for an nstack/Dokploy target.
 */
export function NstackEnvironment(name: string): BaseURL {
    return nstackEnvironment(name)
}

function nstackEnvironment(name: string): BaseURL {
    const target = nstackNormalizeTarget(name)
    if (target === "local") return Local

    const env = nstackRuntimeEnv()
    const currentTarget = nstackNormalizeTarget(nstackEnvValue(env, "NSTACK_TARGET", "NUXT_PUBLIC_NSTACK_TARGET") || "prod")
    const explicit = nstackApiBaseURLForTarget(env, target)
    if (explicit) return explicit

    if (target === currentTarget) {
        if (!nstackIsBrowser()) {
            const serverBase = nstackCleanBaseURL(nstackEnvValue(env, "NSTACK_API_BASE_URL", "NUXT_API_SERVER_BASE_URL", "NUXT_API_INTERNAL_BASE_URL"))
            if (serverBase) return serverBase
        }
        const publicBase = nstackCleanBaseURL(nstackEnvValue(env, "NUXT_PUBLIC_API_BASE_URL", "NUXT_PUBLIC_NSTACK_API_BASE_URL", "NSTACK_PUBLIC_API_BASE_URL"))
        if (publicBase) return publicBase
        const domain = nstackDomainForTarget(env, target) || nstackEnvValue(env, "NSTACK_DOMAIN", "NUXT_PUBLIC_NSTACK_DOMAIN")
        if (domain && !nstackIsBrowser()) return nstackDomainApiBaseURL(domain)
        if (nstackIsBrowser()) return "/api"
    }

    const domain = nstackDomainForTarget(env, target)
    if (domain) return nstackDomainApiBaseURL(domain)

    throw new Error(\`nstack API environment "\${name}" is not configured. Set NUXT_PUBLIC_NSTACK_\${nstackEnvKey(target)}_API_BASE_URL or pass a BaseURL to new Client(...).\`)
}

function nstackApiBaseURLForTarget(env: Record<string, string | undefined>, target: string): BaseURL {
    const key = nstackEnvKey(target)
    return nstackCleanBaseURL(nstackEnvValue(env, \`NSTACK_\${key}_API_BASE_URL\`, \`NUXT_PUBLIC_NSTACK_\${key}_API_BASE_URL\`))
}

function nstackDomainForTarget(env: Record<string, string | undefined>, target: string): string {
    const key = nstackEnvKey(target)
    return nstackEnvValue(env, \`NSTACK_\${key}_DOMAIN\`, \`NUXT_PUBLIC_NSTACK_\${key}_DOMAIN\`) || ""
}

function nstackDomainApiBaseURL(domain: string): BaseURL {
    return \`https://\${String(domain).replace(/^https?:\\/\\//, "").replace(/\\/+$/, "")}/api\`
}

function nstackNormalizeTarget(name: string): string {
    const value = String(name || "prod").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prod"
    return value === "production" ? "prod" : value
}

function nstackEnvKey(target: string): string {
    return nstackNormalizeTarget(target).replace(/[^a-z0-9]+/g, "_").toUpperCase()
}

function nstackRuntimeEnv(): Record<string, string | undefined> {
    const global = globalThis as any
    const processEnv = global && typeof global.process === "object" && typeof global.process.env === "object" ? global.process.env : {}
    const metaEnv = typeof import.meta === "object" && (import.meta as any).env ? (import.meta as any).env : {}
    return { ...processEnv, ...metaEnv }
}

function nstackEnvValue(env: Record<string, string | undefined>, ...keys: string[]): string {
    for (const key of keys) {
        const value = env[key]
        if (typeof value === "string" && value.length > 0) return value
    }
    return ""
}

function nstackCleanBaseURL(value: string): BaseURL {
    return String(value || "").replace(/\\/+$/, "")
}

function nstackIsBrowser(): boolean {
    return typeof globalThis === "object" && ("window" in globalThis)
}`;
}
