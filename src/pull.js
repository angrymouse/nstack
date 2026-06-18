import path from "node:path";
import {
  loadConfig,
  loadState,
  saveState,
  secretsEnvPathForTarget,
  targetFromOptions,
} from "./config.js";
import { inspectResources } from "./doctor.js";
import { DokployProvider } from "./providers/dokploy.js";
import { formatDotEnv, parseDotEnv, readText, writeText, ensureDir } from "./util.js";

export async function pull(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }

  const state = loadState(cwd, config.deploy.target);
  const resources = await inspectResources(cwd, config);
  const provider = new DokployProvider({ config, state });
  const pulled = await provider.pullExistingState(resources);
  const nextState = mergePulledState({ config, state, resources, pulled, force: options.force });
  saveState(nextState, cwd, config.deploy.target);

  const secrets = mergePulledSecrets({
    cwd,
    config,
    resources,
    env: pulled.env,
    force: options.force,
    all: options.all,
  });
  const report = {
    app: config.app.slug,
    target: config.deploy.target,
    state: {
      projectId: nextState.dokploy?.projectId || null,
      environmentId: nextState.dokploy?.environmentId || null,
      composeId: nextState.dokploy?.composeId || null,
      postgresId: nextState.dokploy?.postgresId || null,
      redisId: nextState.dokploy?.redisId || null,
      scheduleCount: Object.keys(nextState.dokploy?.schedules || {}).length,
      postgresPasswordSet: Boolean(nextState.infra?.postgres?.password),
      redisPasswordSet: Boolean(nextState.infra?.redis?.password),
    },
    remote: {
      compose: pulled.compose?.name || pulled.compose?.id || null,
      envKeys: Object.keys(pulled.env || {}).sort(),
    },
    secrets,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`Pulled ${config.app.slug} (${config.deploy.target}) from Dokploy`);
  console.log(`  project: ${report.state.projectId || "(missing)"}`);
  console.log(`  environment: ${report.state.environmentId || "(missing)"}`);
  console.log(`  compose: ${report.state.composeId || "(missing)"}`);
  console.log(`  postgres: ${report.state.postgresId || "(none)"}`);
  console.log(`  redis: ${report.state.redisId || "(none)"}`);
  console.log(`  schedules: ${report.state.scheduleCount}`);
  console.log(`  env keys: ${report.remote.envKeys.length}`);
  console.log(`  app secrets mode: ${report.secrets.mode}`);
  console.log(`  app secrets written: ${report.secrets.written.length ? report.secrets.written.join(", ") : "none"}`);
  return report;
}

function mergePulledState({ config, state, resources, pulled, force }) {
  const env = pulled.env || {};
  return {
    ...state,
    dokploy: {
      ...(state.dokploy || {}),
      ...pulled.dokploy,
    },
    infra: mergePulledInfra({ config, resources, current: state.infra || {}, env, force }),
  };
}

function mergePulledInfra({ config, resources, current, env, force }) {
  const next = { ...current };
  if (resources.databases.length > 0) {
    next.postgres = {
      appName: current.postgres?.appName || `${config.app.slug}-postgres`,
      host: current.postgres?.host || `${config.app.slug}-postgres:5432`,
      database: current.postgres?.database || config.app.slug.replaceAll("-", "_"),
      user: current.postgres?.user || "nstack",
      password: chooseValue(current.postgres?.password, env.NSTACK_POSTGRES_PASSWORD, force),
    };
  }
  if (resources.caches.length > 0) {
    next.redis = {
      appName: current.redis?.appName || `${config.app.slug}-redis`,
      host: current.redis?.host || `${config.app.slug}-redis:6379`,
      password: chooseValue(current.redis?.password, env.NSTACK_REDIS_PASSWORD, force),
    };
  }
  return next;
}

function mergePulledSecrets({ cwd, config, resources, env, force, all }) {
  const file = path.join(cwd, secretsEnvPathForTarget(config.deploy.target));
  const current = parseDotEnv(readText(file, ""));
  const next = { ...current };
  const desiredKeys = desiredSecretKeys(resources, env, { all });
  const written = [];
  const skipped = [];
  const missing = [];

  for (const key of desiredKeys) {
    if (!Object.hasOwn(env, key)) {
      missing.push(key);
      continue;
    }
    if (!force && current[key]) {
      skipped.push(key);
      continue;
    }
    next[key] = env[key];
    written.push(key);
  }

  if (written.length > 0 || (force && desiredKeys.length > 0)) {
    ensureDir(path.dirname(file));
    writeText(file, formatDotEnv(next));
  }

  return {
    mode: all ? "all" : "declared",
    available: remoteAppEnvKeys(env),
    declared: [...resources.secrets].sort(),
    written: written.sort(),
    skipped: skipped.sort(),
    missing: missing.sort(),
  };
}

function desiredSecretKeys(resources, env, { all }) {
  const keys = new Set(resources.secrets);
  if (all) {
    for (const key of remoteAppEnvKeys(env)) keys.add(key);
  }
  return [...keys].sort();
}

function remoteAppEnvKeys(env = {}) {
  return Object.keys(env)
    .filter((key) => !infraEnvKeys.has(key))
    .sort();
}

const infraEnvKeys = new Set([
  "NSTACK_POSTGRES_PASSWORD",
  "NSTACK_REDIS_PASSWORD",
]);

function chooseValue(current, remote, force) {
  if (force && remote) return remote;
  return current || remote || "";
}
