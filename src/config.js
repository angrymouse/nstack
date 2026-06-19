import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDir, fileExists, readJSON, slugify, writeJSON } from "./util.js";
import { parseDotEnv, readText } from "./util.js";

export const statePath = ".nstack/state.json";
export const localEnvPath = ".nstack/local.env";
export const secretsEnvPath = ".nstack/secrets.env";
export const generatedDir = "deploy/nstack";

export async function loadConfig(cwd = process.cwd(), options = {}) {
  const configFile = path.join(cwd, "nstack.config.mjs");
  if (!fileExists(configFile)) {
    throw new Error("nstack.config.mjs not found. Run `nstack init` first.");
  }
  const requestedTarget = targetFromOptions(options);
  const restoreEnv = applyLocalEnv(cwd, requestedTarget);
  try {
    const mod = await import(`${pathToFileURL(configFile).href}?t=${Date.now()}`);
    const config = mod.default || mod.config;
    if (!config || typeof config !== "object") throw new Error("nstack.config.mjs must export a config object.");
    return normalizeConfig(config, { target: requestedTarget });
  } finally {
    restoreEnv();
  }
}

export function normalizeConfig(config, options = {}) {
  const app = config.app || {};
  const paths = config.paths || {};
  const deploy = config.deploy || {};
  const provider = deploy.provider || {};
  const target = normalizeTarget(options.target || process.env.NSTACK_TARGET || deploy.target || "prod");
  return {
    app: {
      name: app.name || "app",
      slug: app.slug || app.name || "app",
      domain: process.env.NSTACK_DOMAIN || app.domain || "",
    },
    paths: {
      backend: paths.backend || "backend",
      backendContext: paths.backendContext || ".",
      backendDockerfile: paths.backendDockerfile || "backend/Dockerfile",
      frontend: paths.frontend || "frontend",
      frontendContext: paths.frontendContext || paths.frontend || "frontend",
      frontendDockerfile: paths.frontendDockerfile || "frontend/Dockerfile",
    },
    deploy: {
      target,
      registry: process.env.NSTACK_REGISTRY || deploy.registry || "",
      buildMode: normalizeBuildMode(process.env.NSTACK_BUILD_MODE || deploy.buildMode, process.env.NSTACK_REGISTRY || deploy.registry || ""),
      platform: process.env.NSTACK_PLATFORM || process.env.PROD_PLATFORM || deploy.platform || "linux/amd64",
      source: normalizeSource(deploy.source || {}),
      provider: {
        type: provider.type || "dokploy",
        url: process.env.DOKPLOY_URL || provider.url || "",
        apiKey: process.env.DOKPLOY_API_KEY || provider.apiKey || "",
        projectName: process.env.DOKPLOY_PROJECT || provider.projectName || app.name || "app",
        environmentName: process.env.DOKPLOY_ENVIRONMENT || provider.environmentName || (target === "prod" ? "production" : target),
        serverId: process.env.DOKPLOY_SERVER_ID || provider.serverId || "",
      },
    },
    verify: {
      timeoutSeconds: Number(config.verify?.timeoutSeconds ?? 120),
      requestTimeoutMs: Number(config.verify?.requestTimeoutMs ?? 2000),
      endpoints: config.verify?.endpoints || [
        { name: "frontend", path: "/", expectStatus: 200, rejectText: ["fetch failed", "Registry read failed", "Nuxt instance unavailable"] },
        { name: "api status", path: "/api/status", expectStatus: 200 },
      ],
    },
  };
}

export function normalizeBuildMode(value, registry = "") {
  const mode = String(value || "").trim().toLowerCase();
  if (["registry", "image", "images", "push"].includes(mode)) return "registry";
  if (["compose", "dokploy", "source", "source-build", "remote"].includes(mode)) return "compose";
  return registry ? "registry" : "compose";
}

function normalizeSource(source = {}) {
  const sourceType = normalizeSourceType(process.env.NSTACK_SOURCE_TYPE || process.env.DOKPLOY_SOURCE_TYPE || source.sourceType || source.type || "");
  return {
    ...(sourceType ? { sourceType } : {}),
    repository: process.env.NSTACK_REPOSITORY || process.env.DOKPLOY_REPOSITORY || source.repository || "",
    branch: process.env.NSTACK_BRANCH || process.env.DOKPLOY_BRANCH || source.branch || "",
    githubId: process.env.NSTACK_GITHUB_ID || process.env.DOKPLOY_GITHUB_ID || source.githubId || "",
    gitlabId: process.env.NSTACK_GITLAB_ID || process.env.DOKPLOY_GITLAB_ID || source.gitlabId || "",
    bitbucketId: process.env.NSTACK_BITBUCKET_ID || process.env.DOKPLOY_BITBUCKET_ID || source.bitbucketId || "",
    giteaId: process.env.NSTACK_GITEA_ID || process.env.DOKPLOY_GITEA_ID || source.giteaId || "",
    gitlabProjectId: normalizeOptionalNumber(process.env.NSTACK_GITLAB_PROJECT_ID || source.gitlabProjectId),
    gitlabPathNamespace: process.env.NSTACK_GITLAB_PATH_NAMESPACE || source.gitlabPathNamespace || "",
    bitbucketRepositorySlug: process.env.NSTACK_BITBUCKET_REPOSITORY_SLUG || source.bitbucketRepositorySlug || "",
    sshKeyId: process.env.NSTACK_GIT_SSH_KEY_ID || process.env.DOKPLOY_GIT_SSH_KEY_ID || source.sshKeyId || source.customGitSSHKeyId || "",
    composePath: process.env.NSTACK_COMPOSE_PATH || source.composePath || "",
    watchPaths: normalizeWatchPaths(process.env.NSTACK_WATCH_PATHS || source.watchPaths || []),
  };
}

function normalizeSourceType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  if (["github", "gitlab", "bitbucket", "gitea", "git", "raw"].includes(type)) return type;
  return "";
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function normalizeWatchPaths(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function targetFromOptions(options = {}) {
  return options.target || options.env || "";
}

export function normalizeTarget(target = "prod") {
  return slugify(target || "prod");
}

export function localEnvPathForTarget(target = "prod") {
  return targetScopedPath(localEnvPath, target);
}

export function secretsEnvPathForTarget(target = "prod") {
  return targetScopedPath(secretsEnvPath, target);
}

export function statePathForTarget(target = "prod") {
  return targetScopedPath(statePath, target);
}

function targetScopedPath(basePath, target = "prod") {
  const normalized = normalizeTarget(target);
  if (normalized === "prod") return basePath;
  const ext = path.extname(basePath);
  const dir = path.dirname(basePath);
  const name = path.basename(basePath, ext);
  return path.join(dir, `${name}.${normalized}${ext}`);
}

function applyLocalEnv(cwd, requestedTarget = "") {
  const baseEnv = parseDotEnv(readText(path.join(cwd, localEnvPath), ""));
  const processTarget = process.env.NSTACK_TARGET || "";
  const baseTarget = baseEnv.NSTACK_TARGET || "prod";
  const target = normalizeTarget(requestedTarget || processTarget || baseTarget);
  const useBaseEnv = target === "prod" || (!requestedTarget && !processTarget && normalizeTarget(baseTarget) === target);
  const targetEnv = target === "prod" ? {} : parseDotEnv(readText(path.join(cwd, localEnvPathForTarget(target)), ""));
  const changed = new Map();
  const appliedLocalKeys = new Set();

  const setFromLocal = (key, value, { force = false } = {}) => {
    if (!force && process.env[key] !== undefined && !appliedLocalKeys.has(key)) return;
    if (!changed.has(key)) changed.set(key, process.env[key]);
    process.env[key] = value;
    appliedLocalKeys.add(key);
  };

  if (useBaseEnv) {
    for (const [key, value] of Object.entries(baseEnv)) setFromLocal(key, value);
  }
  if (requestedTarget) setFromLocal("NSTACK_TARGET", target, { force: true });
  for (const [key, value] of Object.entries(targetEnv)) setFromLocal(key, value);
  if (requestedTarget) setFromLocal("NSTACK_TARGET", target, { force: true });

  return () => {
    for (const [key, value] of changed.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function loadState(cwd = process.cwd(), target = "prod") {
  return readJSON(path.join(cwd, statePathForTarget(target)), {});
}

export function saveState(state, cwd = process.cwd(), target = "prod") {
  ensureDir(path.join(cwd, ".nstack"));
  writeJSON(path.join(cwd, statePathForTarget(target)), state);
}
