import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const clientModes = new Set(["gen", "check", "watch", "bench", "benchmark"]);
const ignoredDirs = new Set(["node_modules", ".encore", "encore.gen", ".turbo", ".cache", "dist", "coverage"]);
const watchedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".sql"]);
const postprocessVersion = "nstack-dokploy-env-v1";
const activeTempDirs = new Set();

let tempSignalHandlersInstalled = false;

export function hasClientGenerator(cwd) {
  const root = path.resolve(cwd);
  return existsSync(path.join(root, "backend", "encore.app"))
    && existsSync(path.join(root, "frontend", "app"));
}

export function runClientGenerator(cwd, mode = "gen", options = {}) {
  if (!hasClientGenerator(cwd)) return { skipped: true };
  const normalized = mode || "gen";
  if (!clientModes.has(normalized)) {
    throw new Error(`Unknown nstack client command: ${normalized}`);
  }
  if (normalized === "watch") {
    throw new Error("Use `nstack client watch` to run the long-running client watcher.");
  }

  const code = clientModeExitCode(cwd, normalized, options);
  if (code !== 0) throw new Error(`nstack client ${normalized} failed with exit code ${code}.`);
  return { skipped: false, mode: normalized };
}

export async function watchClient(cwd, options = {}) {
  if (!hasClientGenerator(cwd)) return { skipped: true };
  const watcher = startClientWatcher(cwd, options);
  await new Promise(() => {});
  watcher.close();
  return { skipped: false, mode: "watch" };
}

export function startClientWatcher(cwd, options = {}) {
  if (!hasClientGenerator(cwd)) {
    return {
      skipped: true,
      close() {},
    };
  }

  let signature = snapshotBackend(cwd);
  let generating = false;
  let queued = false;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    if (generating) {
      queued = true;
      return;
    }
    generating = true;
    try {
      ensureClient(cwd, { force: true, quietUnchanged: true, ...options });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      generating = false;
    }
    if (queued) {
      queued = false;
      run();
    }
  };

  run();
  const timer = setInterval(() => {
    const next = snapshotBackend(cwd);
    if (next === signature) return;
    signature = next;
    run();
  }, watchIntervalMs());

  return {
    skipped: false,
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function clientGeneratorPath() {
  return "nstack client gen";
}

export function ensureClient(cwd, options = {}) {
  const paths = clientPaths(cwd);
  const signature = clientSignature(paths);
  if (!options.force && options.output === undefined && cacheMatches(paths, signature)) return 0;

  const started = performance.now();
  const tempDir = makeTempDir(paths, "client");
  const raw = path.join(tempDir, "raw-client.ts");
  try {
    const code = generateRawClient(paths, raw, options);
    if (code !== 0) return code;
    const text = postprocessClient(readFileSync(raw, "utf8"), paths.root);
    const output = options.output || paths.clientFile;
    mkdirSync(path.dirname(output), { recursive: true });
    const changed = options.output || !existsSync(output) || readFileSync(output, "utf8") !== text;
    if (changed) writeFileAtomic(output, text);
    if (!options.output) writeClientCache(paths, signature, hashText(text));
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

function clientModeExitCode(cwd, mode, options = {}) {
  if (mode === "gen") return ensureClient(cwd, { force: Boolean(options.force), quiet: Boolean(options.capture) });
  if (mode === "check") return checkClient(cwd);
  if (mode === "bench" || mode === "benchmark") return benchmarkClient(cwd);
  return 1;
}

function generateRawClient(paths, output, options = {}) {
  mkdirSync(path.dirname(output), { recursive: true });
  const result = runEncore(paths, ["gen", "client", "--env=local", "--output", output], { quiet: true });
  if (result.status === 0) return 0;

  if (!options.quiet) console.log("Preparing Encore API metadata for client generation...");
  const check = runEncore(paths, ["check"], { quiet: options.quiet });
  if (check.status === 0) {
    const retry = runEncore(paths, ["gen", "client", "--env=local", "--output", output], { quiet: options.quiet });
    if (retry.status === 0) return 0;
    return reportGenerationFailure(retry, { check });
  }

  return reportGenerationFailure(result, { check });
}

function runEncore(paths, args, options = {}) {
  return spawnSync("encore", args, {
    cwd: paths.backendDir,
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
  console.error("nstack generates the client from local Encore metadata.");
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

function checkClient(cwd) {
  const paths = clientPaths(cwd);
  const tempDir = makeTempDir(paths, "client-check");
  const generated = path.join(tempDir, "encore-client.ts");
  try {
    const code = ensureClient(cwd, { output: generated, quiet: true, force: true });
    if (code !== 0) return code;

    if (!existsSync(paths.clientFile)) {
      console.error("The generated Encore client is missing. Run `pnpm check` or `nstack client gen`.");
      return 1;
    }

    const expected = readFileSync(generated, "utf8");
    const current = readFileSync(paths.clientFile, "utf8");
    if (current !== expected) {
      console.error("The generated Encore client is out of date. Run `pnpm check` or `nstack client gen`.");
      return 1;
    }
    return 0;
  } finally {
    removeTempDir(tempDir);
  }
}

function watchIntervalMs() {
  const value = Number(process.env.NSTACK_CLIENT_WATCH_INTERVAL_MS || 500);
  return Number.isFinite(value) ? Math.max(100, value) : 500;
}

function benchmarkClient(cwd) {
  const runs = Number(process.env.NSTACK_CLIENT_BENCH_RUNS || 3);
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const paths = clientPaths(cwd);
    const tempDir = makeTempDir(paths, "client-bench");
    const output = path.join(tempDir, "encore-client.ts");
    const started = performance.now();
    try {
      const code = ensureClient(cwd, { output, quiet: true, force: true });
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

function makeTempDir(paths, prefix) {
  cleanupStaleTempDirs(paths);
  mkdirSync(paths.tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(paths.tempRoot, `${prefix}-${process.pid}-`));
  activeTempDirs.add(dir);
  installTempCleanupHandlers();
  return dir;
}

function removeTempDir(dir) {
  activeTempDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

function cleanupStaleTempDirs(paths) {
  const now = Date.now();
  mkdirSync(paths.tempRoot, { recursive: true });
  const ttlMs = tempTtlMs();
  for (const entry of readdirSync(paths.tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^client(?:-check|-bench)?-/.test(entry.name)) continue;
    const full = path.join(paths.tempRoot, entry.name);
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

function snapshotBackend(cwd) {
  const paths = clientPaths(cwd);
  return listWatchedFiles(paths.backendDir)
    .map((file) => {
      const stat = statSync(file);
      return `${path.relative(paths.backendDir, file)}:${stat.size}:${stat.mtimeMs}`;
    })
    .sort()
    .join("\n");
}

function listWatchedFiles(dir) {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
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

function clientSignature(paths) {
  const hash = createHash("sha256");
  hash.update(`${postprocessVersion}\n`);
  hash.update(`${encoreVersion(paths)}\n`);
  for (const file of listWatchedFiles(paths.backendDir).sort()) {
    hash.update(path.relative(paths.backendDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cacheMatches(paths, signature) {
  if (!existsSync(paths.clientFile) || !existsSync(paths.cacheFile)) return false;
  try {
    const cache = JSON.parse(readFileSync(paths.cacheFile, "utf8"));
    return cache.signature === signature && cache.clientHash === hashFile(paths.clientFile);
  } catch {
    return false;
  }
}

function writeClientCache(paths, signature, clientHash) {
  mkdirSync(path.dirname(paths.cacheFile), { recursive: true });
  writeFileSync(paths.cacheFile, `${JSON.stringify({ signature, clientHash }, null, 2)}\n`);
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

function encoreVersion(paths) {
  const result = spawnSync("encore", ["version"], {
    cwd: paths.backendDir,
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

function postprocessClient(text, cwd) {
  const pattern = /\/\*\*\n \* Environment returns[\s\S]*?export function PreviewEnv\(pr: number \| string\): BaseURL \{\n    return Environment\(`pr\$\{pr\}`\)\n\}/;
  const next = withStableClientAppName(text.replace(pattern, nstackEnvironmentBlock()), cwd);
  if (next === text) throw new Error("Could not patch Encore client environment helpers.");
  if (next.includes(".encr.app")) throw new Error("Generated client still contains Encore Cloud environment URLs.");
  return next;
}

function withStableClientAppName(text, cwd) {
  const name = clientAppName(cwd);
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

function clientAppName(cwd) {
  try {
    return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).name || "nstack";
  } catch {
    return "nstack";
  }
}

function clientPaths(cwd) {
  const root = path.resolve(cwd);
  return {
    root,
    backendDir: path.join(root, "backend"),
    clientFile: path.join(root, "frontend", "app", "generated", "encore-client.ts"),
    cacheFile: path.join(root, ".nstack", "client.json"),
    tempRoot: path.join(root, ".nstack", "tmp"),
  };
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
