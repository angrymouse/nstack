import path from "node:path";
import { readdirSync } from "node:fs";
import {
  localEnvPathForTarget,
  normalizeTarget,
  secretsEnvPathForTarget,
  statePathForTarget,
} from "./config.js";
import { fileExists, parseDotEnv, readJSON, readText } from "./util.js";

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

function discoverTargets(cwd) {
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
