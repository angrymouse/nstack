import path from "node:path";
import { readdirSync } from "node:fs";
import {
  localEnvPathForTarget,
  normalizeTarget,
  secretsEnvPathForTarget,
  statePathForTarget,
} from "./config.js";
import { fileExists, mergeEnvFile, parseDotEnv, readJSON, readText } from "./util.js";

export async function runTargetCommand(args = [], options = {}) {
  const subcommand = args[0] || "";
  if (["create", "copy", "clone"].includes(subcommand)) return createTarget(args.slice(1), options);
  return listTargets(options);
}

export async function listTargets(options = {}) {
  const cwd = options.cwd || process.cwd();
  const targets = discoverTargets(cwd);
  const current = normalizeTarget(options.target || options.env || process.env.NSTACK_TARGET || "prod");
  const report = {
    current,
    targets,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (targets.length === 0) {
    console.log("No nstack deploy targets configured. Run `nstack configure`.");
    return report;
  }

  console.log("targets:");
  for (const target of targets) {
    const marker = target.name === current ? "*" : " ";
    const pieces = [
      target.name,
      target.domain ? `https://${target.domain}` : "(no domain)",
      target.linked ? "linked" : "unlinked",
      target.state.composeId ? `compose=${target.state.composeId}` : "",
      target.release?.tag ? `release=${target.release.tag}` : "",
      target.secrets.count ? `secrets=${target.secrets.count}` : "",
    ].filter(Boolean);
    console.log(`${marker} ${pieces.join("  ")}`);
  }
  return report;
}

export async function createTarget(args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const target = normalizeTarget(args[0] || options.to || options.target || options.env || "");
  if (!target) throw new Error("Target name is required. Use `nstack target create staging --domain staging.example.com`.");
  if (target === "prod") throw new Error("Use `nstack configure` to update the prod target.");

  const from = normalizeTarget(options.from || "prod");
  const baseFile = path.join(cwd, localEnvPathForTarget(from));
  const targetFile = path.join(cwd, localEnvPathForTarget(target));
  if (!fileExists(baseFile)) {
    throw new Error(`Base target ${from} is not configured. Run \`nstack configure${from === "prod" ? "" : ` --env ${from}`}\` first, or pass --from <target>.`);
  }
  if (fileExists(targetFile) && !options.force) {
    throw new Error(`Target ${target} already exists. Pass --force to update ${localEnvPathForTarget(target)}.`);
  }

  const base = parseDotEnv(readText(baseFile, ""));
  const values = {
    ...cloneableTargetEnv(base),
    ...targetEnvValues(options),
    NSTACK_TARGET: target,
  };
  if (!values.NSTACK_DOMAIN) {
    throw new Error("Target domain is required. Pass --domain <host> so this target cannot accidentally reuse another environment's domain.");
  }
  if (!values.DOKPLOY_ENVIRONMENT) values.DOKPLOY_ENVIRONMENT = target;
  if (!values.DOKPLOY_PROJECT && base.DOKPLOY_PROJECT) values.DOKPLOY_PROJECT = base.DOKPLOY_PROJECT;
  if (!values.NSTACK_BRANCH && target !== "prod") values.NSTACK_BRANCH = target;

  mergeEnvFile(targetFile, values);
  const report = {
    target,
    from,
    file: localEnvPathForTarget(target),
    domain: values.NSTACK_DOMAIN,
    project: values.DOKPLOY_PROJECT || null,
    environment: values.DOKPLOY_ENVIRONMENT,
    repository: values.NSTACK_REPOSITORY || null,
    branch: values.NSTACK_BRANCH || null,
    dokployUrl: values.DOKPLOY_URL || null,
    dokployApiKeySet: Boolean(values.DOKPLOY_API_KEY),
    next: [
      `nstack deploy --env ${target}`,
      `nstack status --env ${target}`,
    ],
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`Created target ${target} from ${from}`);
  console.log(`  file: ${report.file}`);
  console.log(`  domain: https://${report.domain}`);
  console.log(`  Dokploy environment: ${report.environment}`);
  if (report.branch) console.log(`  branch: ${report.branch}`);
  console.log("Next:");
  for (const step of report.next) console.log(`  ${step}`);
  return report;
}

export function discoverTargets(cwd) {
  const names = new Set(["prod"]);
  const dir = path.join(cwd, ".nstack");
  for (const file of listFiles(dir)) {
    const target = targetFromNstackFile(file);
    if (target) names.add(target);
  }

  return [...names]
    .map((target) => targetSummary(cwd, target))
    .filter((target) => target.configured)
    .sort(compareTargets);
}

function targetSummary(cwd, target) {
  const localEnvFile = path.join(cwd, localEnvPathForTarget(target));
  const stateFile = path.join(cwd, statePathForTarget(target));
  const secretsFile = path.join(cwd, secretsEnvPathForTarget(target));
  const localEnv = parseDotEnv(readText(localEnvFile, ""));
  const state = readJSON(stateFile, {});
  const secretKeys = Object.keys(parseDotEnv(readText(secretsFile, ""))).sort();
  const name = normalizeTarget(localEnv.NSTACK_TARGET || target);
  return {
    name,
    configured: fileExists(localEnvFile) || fileExists(stateFile) || fileExists(secretsFile),
    domain: localEnv.NSTACK_DOMAIN || "",
    registry: localEnv.NSTACK_REGISTRY || "",
    platform: localEnv.NSTACK_PLATFORM || "",
    project: localEnv.DOKPLOY_PROJECT || "",
    environment: localEnv.DOKPLOY_ENVIRONMENT || "",
    dokployUrl: localEnv.DOKPLOY_URL || "",
    dokployApiKeySet: Boolean(localEnv.DOKPLOY_API_KEY),
    linked: Boolean(localEnv.DOKPLOY_URL && localEnv.DOKPLOY_API_KEY),
    files: {
      localEnv: fileExists(localEnvFile) ? localEnvPathForTarget(target) : null,
      state: fileExists(stateFile) ? statePathForTarget(target) : null,
      secrets: fileExists(secretsFile) ? secretsEnvPathForTarget(target) : null,
    },
    secrets: {
      count: secretKeys.length,
      keys: secretKeys,
    },
    state: {
      projectId: state.dokploy?.projectId || null,
      environmentId: state.dokploy?.environmentId || null,
      composeId: state.dokploy?.composeId || null,
      postgresId: state.dokploy?.postgresId || null,
      redisId: state.dokploy?.redisId || null,
      scheduleCount: Object.keys(state.dokploy?.schedules || {}).length,
    },
    release: state.lastRelease || null,
    attempt: state.lastAttempt || null,
    lastEnvPush: state.lastEnvPush || null,
  };
}

function listFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function targetFromNstackFile(file) {
  if (file === "local.env" || file === "state.json" || file === "secrets.env") return "prod";
  const match = file.match(/^(?:local|state|secrets)\.([A-Za-z0-9_-]+)\.(?:env|json)$/);
  return match ? normalizeTarget(match[1]) : "";
}

function compareTargets(a, b) {
  if (a.name === "prod") return -1;
  if (b.name === "prod") return 1;
  return a.name.localeCompare(b.name);
}

function cloneableTargetEnv(env = {}) {
  const keys = [
    "NSTACK_BUILD_MODE",
    "NSTACK_REGISTRY",
    "NSTACK_REPOSITORY",
    "NSTACK_BRANCH",
    "NSTACK_SOURCE_TYPE",
    "NSTACK_GITHUB_ID",
    "NSTACK_GITLAB_ID",
    "NSTACK_BITBUCKET_ID",
    "NSTACK_GITEA_ID",
    "NSTACK_GITLAB_PROJECT_ID",
    "NSTACK_GITLAB_PATH_NAMESPACE",
    "NSTACK_BITBUCKET_REPOSITORY_SLUG",
    "NSTACK_GIT_SSH_KEY_ID",
    "NSTACK_COMPOSE_PATH",
    "NSTACK_WATCH_PATHS",
    "DOKPLOY_URL",
    "DOKPLOY_API_KEY",
    "DOKPLOY_SERVER_ID",
    "DOKPLOY_PROJECT",
    "NSTACK_PLATFORM",
  ];
  return Object.fromEntries(keys
    .map((key) => [key, env[key]])
    .filter(([, value]) => value !== undefined && value !== ""));
}

function targetEnvValues(options = {}) {
  return {
    ...(options.domain ? { NSTACK_DOMAIN: options.domain } : {}),
    ...(options.buildMode ? { NSTACK_BUILD_MODE: options.buildMode } : {}),
    ...(options.registry ? { NSTACK_REGISTRY: options.registry } : {}),
    ...(options.repository ? { NSTACK_REPOSITORY: options.repository } : {}),
    ...(options.branch ? { NSTACK_BRANCH: options.branch } : {}),
    ...(options.sourceType ? { NSTACK_SOURCE_TYPE: options.sourceType } : {}),
    ...(options.githubId ? { NSTACK_GITHUB_ID: options.githubId } : {}),
    ...(options.gitlabId ? { NSTACK_GITLAB_ID: options.gitlabId } : {}),
    ...(options.bitbucketId ? { NSTACK_BITBUCKET_ID: options.bitbucketId } : {}),
    ...(options.giteaId ? { NSTACK_GITEA_ID: options.giteaId } : {}),
    ...(options.gitlabProjectId ? { NSTACK_GITLAB_PROJECT_ID: options.gitlabProjectId } : {}),
    ...(options.gitlabPathNamespace ? { NSTACK_GITLAB_PATH_NAMESPACE: options.gitlabPathNamespace } : {}),
    ...(options.bitbucketRepositorySlug ? { NSTACK_BITBUCKET_REPOSITORY_SLUG: options.bitbucketRepositorySlug } : {}),
    ...(options.sshKeyId ? { NSTACK_GIT_SSH_KEY_ID: options.sshKeyId } : {}),
    ...(options.composePath ? { NSTACK_COMPOSE_PATH: options.composePath } : {}),
    ...(options.watchPaths ? { NSTACK_WATCH_PATHS: options.watchPaths } : {}),
    ...(options.dokployUrl ? { DOKPLOY_URL: options.dokployUrl } : {}),
    ...(options.dokployApiKey ? { DOKPLOY_API_KEY: options.dokployApiKey } : {}),
    ...(options.serverId ? { DOKPLOY_SERVER_ID: options.serverId } : {}),
    ...(options.platform ? { NSTACK_PLATFORM: options.platform } : {}),
    ...(options.project ? { DOKPLOY_PROJECT: options.project } : {}),
    ...(options.environment ? { DOKPLOY_ENVIRONMENT: options.environment } : {}),
  };
}
