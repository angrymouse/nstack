import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandOutput, readJSON, run } from "./util.js";
import { currentVersion, packageRoot } from "./version.js";

const defaultReleaseUrl = "https://nstack.tech/api/releases/latest";
const defaultRepo = "https://git.nik.technology/angrymouse/nstack.git";
const defaultRef = "main";
const defaultCheckIntervalMs = 24 * 60 * 60 * 1000;

export async function runUpdateCommand(options = {}) {
  const release = await latestRelease(options);
  const localVersion = currentVersion();
  const updateAvailable = compareVersions(release.version, localVersion) > 0;

  if (options.check) {
    return {
      checked: true,
      updated: false,
      updateAvailable,
      currentVersion: localVersion,
      latestVersion: release.version,
      release,
    };
  }

  if (!updateAvailable && !options.force) {
    return {
      checked: true,
      updated: false,
      updateAvailable: false,
      currentVersion: localVersion,
      latestVersion: release.version,
      release,
    };
  }

  const git = updateFromGit({ release, options });
  return {
    checked: true,
    updated: true,
    updateAvailable,
    previousVersion: localVersion,
    currentVersion: git.version,
    latestVersion: release.version,
    release,
    git,
  };
}

export async function maybePrintUpdateNotice({ command = "", options = {} } = {}) {
  if (!shouldCheckForUpdates(command, options)) return null;
  const cache = readUpdateCache();
  const now = Date.now();
  const intervalMs = updateCheckIntervalMs();
  if (cache.checkedAt && now - cache.checkedAt < intervalMs) {
    if (cache.updateAvailable) printNotice(cache);
    return cache;
  }

  try {
    const release = await latestRelease(options);
    const localVersion = currentVersion();
    const updateAvailable = compareVersions(release.version, localVersion) > 0;
    const next = {
      checkedAt: now,
      currentVersion: localVersion,
      latestVersion: release.version,
      updateAvailable,
      release,
    };
    writeUpdateCache(next);
    if (updateAvailable) printNotice(next);
    return next;
  } catch {
    writeUpdateCache({ ...cache, checkedAt: now, error: true });
    return null;
  }
}

export async function latestRelease(options = {}) {
  const url = releaseMetadataUrl(options);
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.NSTACK_UPDATE_TIMEOUT_MS || 2500)),
  });
  if (!response.ok) throw new Error(`Could not read nstack release metadata: HTTP ${response.status}`);
  return normalizeRelease(await response.json(), url);
}

export function printUpdateReport(report, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.updated) {
    console.log(`Updated nstack ${report.previousVersion} -> ${report.currentVersion}`);
    printChangelog(report.release);
    return;
  }

  if (report.updateAvailable) {
    console.log(`nstack ${report.latestVersion} is available. Run \`nstack update\`.`);
    printChangelog(report.release);
    return;
  }

  console.log(`nstack is up to date (${report.currentVersion || report.latestVersion}).`);
}

function updateFromGit({ release, options = {} }) {
  assertInstalledCheckout(options);
  const remote = updateRepo(options);
  const ref = updateRef(release, options);
  ensureCleanCheckout(options);
  ensureRemote(remote);

  let fetch = runGit(["fetch", "origin", ref, "--depth", "1"], { allowFailure: true });
  if (fetch.status !== 0) fetch = runGit(["fetch", "origin", ref], { allowFailure: true });
  if (fetch.status !== 0) {
    throw new Error(`Could not fetch ${ref} from ${remote}.`);
  }
  runGit(["checkout", "-B", ref, "FETCH_HEAD"]);
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: packageRoot, capture: true });

  const bin = path.join(packageRoot, "bin", "nstack.js");
  chmodSync(bin, 0o755);
  ensureBinSymlink(bin, options);

  return {
    repo: remote,
    ref,
    commit: safeGit(["rev-parse", "HEAD"]),
    version: JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || "0.0.0",
  };
}

function assertInstalledCheckout(options = {}) {
  if (existsSync(path.join(packageRoot, ".git"))) return;
  throw new Error("This nstack copy is not a git checkout. Reinstall with `curl -fsSL https://nstack.tech/install.sh | bash`.");
}

function ensureCleanCheckout(options = {}) {
  const dirty = safeGit(["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty || options.force) return;
  throw new Error("The nstack checkout has local tracked changes. Commit or remove them, or pass --force.");
}

function ensureRemote(remote) {
  const current = safeGit(["remote", "get-url", "origin"]);
  if (!current) {
    runGit(["remote", "add", "origin", remote]);
    return;
  }
  if (current !== remote && process.env.NSTACK_UPDATE_SET_ORIGIN === "1") {
    runGit(["remote", "set-url", "origin", remote]);
  }
}

function ensureBinSymlink(bin, options = {}) {
  if (process.platform === "win32") return;
  const binDir = options.binDir || process.env.NSTACK_BIN_DIR || path.join(os.homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, "nstack");
  rmSync(link, { force: true });
  symlinkSync(bin, link, "file");
}

function runGit(args, options = {}) {
  return run("git", args, { cwd: packageRoot, capture: true, allowFailure: Boolean(options.allowFailure) });
}

function safeGit(args) {
  try {
    return commandOutput("git", args, { cwd: packageRoot }).trim();
  } catch {
    return "";
  }
}

function updateRepo(options = {}) {
  return options.repo || process.env.NSTACK_REPO || safeGit(["remote", "get-url", "origin"]) || defaultRepo;
}

function updateRef(release = {}, options = {}) {
  return options.ref || process.env.NSTACK_REF || release.branch || defaultRef;
}

function normalizeRelease(raw, url) {
  const version = String(raw?.version || raw?.latestVersion || "").trim();
  if (!version) throw new Error(`Release metadata from ${url} did not include a version.`);
  return {
    source: raw?.source || url,
    version,
    branch: raw?.branch || defaultRef,
    commit: raw?.commit || "",
    repository: raw?.repository || defaultRepo,
    url: raw?.url || "",
    fetchedAt: raw?.fetchedAt || raw?.generatedAt || "",
    changelog: Array.isArray(raw?.changelog) ? raw.changelog.map(normalizeChange).filter(Boolean) : [],
  };
}

function normalizeChange(item) {
  if (!item) return null;
  const message = String(item.message || item.subject || item.title || "").trim();
  if (!message) return null;
  return {
    commit: String(item.commit || item.sha || "").slice(0, 12),
    message,
    date: item.date || item.created || "",
    url: item.url || "",
  };
}

function releaseMetadataUrl(options = {}) {
  return options.metadataUrl || process.env.NSTACK_RELEASE_URL || process.env.NSTACK_UPDATE_URL || defaultReleaseUrl;
}

function shouldCheckForUpdates(command, options = {}) {
  if (options.json || options.help || options.version) return false;
  if (["help", "version", "update", "dev", "devexec", "dev-exec"].includes(command)) return false;
  if (process.env.CI || process.env.NSTACK_UPDATE_CHECK === "0") return false;
  if (process.stderr.isTTY !== true) return false;
  return true;
}

function printNotice(cache) {
  const current = cache.currentVersion || currentVersion();
  const latest = cache.latestVersion || cache.release?.version;
  if (!latest || compareVersions(latest, current) <= 0) return;
  process.stderr.write(`nstack ${latest} is available. Run \`nstack update\`.\n`);
}

function printChangelog(release) {
  const changes = (release?.changelog || []).slice(0, 5);
  if (changes.length === 0) return;
  console.log("Changes:");
  for (const change of changes) {
    const commit = change.commit ? `${change.commit} ` : "";
    console.log(`  ${commit}${change.message}`);
  }
}

function updateCachePath() {
  if (process.env.NSTACK_UPDATE_CACHE) return process.env.NSTACK_UPDATE_CACHE;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "nstack", "update.json");
}

function readUpdateCache() {
  return readJSON(updateCachePath(), {});
}

function writeUpdateCache(value) {
  const file = updateCachePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function updateCheckIntervalMs() {
  const value = Number(process.env.NSTACK_UPDATE_CHECK_INTERVAL_MS || defaultCheckIntervalMs);
  return Number.isFinite(value) && value >= 0 ? value : defaultCheckIntervalMs;
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionParts(value) {
  return String(value || "")
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}
