import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildBackendImage } from "./backend-build.js";
import { composeEnvironmentValues, renderComposeEnvironment } from "./compose-env.js";
import {
  loadConfig,
  loadState,
  saveState,
  generatedDir,
  localEnvPathForTarget,
  normalizeBuildMode,
  normalizeTarget,
  secretsEnvPathForTarget,
  targetFromOptions,
} from "./config.js";
import { createDoctorReport, inspectResources, preflightError, preflightFailures } from "./doctor.js";
import { normalizeTargetPlatform } from "./platform.js";
import { DokployProvider, existingInfraSecretError } from "./providers/dokploy.js";
import { renderDokployCompose } from "./render/compose.js";
import { renderEncoreInfra } from "./render/infra.js";
import { Prompter } from "./prompt.js";
import { createStatusReport, statusCheckError } from "./status.js";
import { ensureDir, fileExists, randomSecret, run, commandOutput, writeText, mergeEnvFile, parseDotEnv, readText, readJSON, writeJSON } from "./util.js";

const releaseManifestName = "release.json";
const releaseManifestSchema = "nstack.release.v1";
const maxReleaseHistory = 20;

export async function configure(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await completeDeployConfig(await loadConfig(cwd, { target: targetFromOptions(options) }), cwd, options);
  const report = configureReport(config);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(`Configured ${config.app.slug}`);
  console.log(`  domain: https://${config.app.domain}`);
  console.log(`  target: ${config.deploy.target}`);
  console.log(`  build mode: ${config.deploy.buildMode}`);
  if (config.deploy.buildMode === "registry") console.log(`  registry: ${config.deploy.registry}`);
  if (config.deploy.buildMode === "compose") console.log(`  source: ${config.deploy.source.repository || "(missing)"}`);
  console.log(`  provider: ${config.deploy.provider.type}`);
  return report;
}

export async function deploy(options = {}) {
  const cwd = options.cwd || process.cwd();
  let config = await loadConfig(cwd, { target: targetFromOptions(options) });
  config = await completeDeployConfig(config, cwd, options);
  const state = loadState(cwd, config.deploy.target);
  const skipBuild = Boolean(options.skipBuild || options.prebuilt || config.deploy.buildMode === "compose");
  const release = resolveRelease(config, cwd, { ...options, skipBuild });
  const resources = await inspectResources(cwd, config);
  const localOnly = options.renderOnly || options.dryRun || options.buildOnly;
  const command = options.buildOnly ? "build" : localOnly ? "render" : "deploy";
  const initialReport = await createDoctorReport({ cwd, config, state, resources });
  assertPreflight(command, initialReport, {
    skipBuild,
    ignore: localOnly ? [] : ["app-secrets"],
  });
  if (!localOnly) {
    const remoteReport = await createDoctorReport({ cwd, config, state, resources, checkRemote: true });
    assertPreflight("deploy", remoteReport, {
      skipBuild,
      ignore: ["app-secrets"],
    });
  }
  const secretEnv = localOnly ? {} : await completeAppSecrets(resources, cwd, options, config.deploy.target);
  if (!localOnly) {
    const secretsReport = await createDoctorReport({ cwd, config, state, resources });
    assertPreflight("deploy", secretsReport, { skipBuild });
  }
  const infra = ensureInfraSecrets({ config, resources, state });
  const generatedInfraSecrets = {
    postgres: resources.databases.length > 0 && !state.infra?.postgres?.password,
    redis: resources.caches.length > 0 && !state.infra?.redis?.password,
  };
  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
    infra,
  };
  const safeGeneratedInfra = { postgres: false, redis: false };
  const persistState = () => saveState(
    stateForSafeSave(nextState, generatedInfraSecrets, safeGeneratedInfra),
    cwd,
    config.deploy.target,
  );
  const persistFullState = () => saveState(nextState, cwd, config.deploy.target);

  const infraFile = path.join(cwd, generatedDir, "encore.infra.json");
  const composeFile = path.join(cwd, generatedDir, "compose.dokploy.yaml");
  const releaseFile = releaseManifestPath(cwd);
  const timings = [];
  ensureDir(path.dirname(infraFile));
  let infraText = renderEncoreInfra({ config, state, resources, infra, release, secretEnv });
  let artifacts = deploymentArtifacts({ config, release, infraText, localContext: localOnly });
  let images = artifacts.images;
  let ctx = { config, state, resources, infra, images, build: artifacts.build, release, secretEnv };
  const composeBuildEnv = composeEnvironmentValues({
    resources,
    infra,
    secretEnv: buildOnlySecretEnv(resources, secretEnv),
    buildEnv: composeBuildValues({ config, release, infraText }),
  });
  writeText(infraFile, infraText);
  writeText(composeFile, renderDokployCompose(ctx));

  if (options.renderOnly || options.dryRun) {
    const report = deploymentReport({
      mode: options.dryRun ? "dry-run" : "render",
      config,
      resources,
      images,
      artifacts,
      release,
      infraFile,
      composeFile,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printPlan({ config, resources, images, artifacts, release, infraFile, composeFile });
    return report;
  }

  if (options.buildOnly) {
    buildArtifacts({ config, cwd, artifacts, images, infraFile, composeFile, composeEnv: composeBuildEnv, quiet: options.json, timings });
    writeReleaseManifest(releaseFile, releaseManifest({ config, resources, images, release, infraFile, composeFile }));
    const report = deploymentReport({
      mode: "build",
      config,
      resources,
      images,
      artifacts,
      release,
      infraFile,
      composeFile,
      releaseFile,
      timings,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printBuild({ config, images, artifacts, release, infraFile, composeFile, releaseFile });
    return report;
  }

  if (!skipBuild) {
    buildArtifacts({ config, cwd, artifacts, images, infraFile, composeFile, composeEnv: composeBuildEnv, quiet: options.json, timings });
    writeReleaseManifest(releaseFile, releaseManifest({ config, resources, images, release, infraFile, composeFile }));
  }

  const provider = new DokployProvider({ config, state: nextState });
  const projectId = await provider.ensureProject();
  nextState.dokploy.projectId = projectId;
  persistState();

  const environmentId = await provider.ensureEnvironment(projectId);
  nextState.dokploy.environmentId = environmentId;
  persistState();

  if (resources.databases.length > 0) {
    const existingPostgresId = nextState.dokploy.postgresId || await provider.findPostgresId(environmentId);
    if (existingPostgresId && generatedInfraSecrets.postgres) {
      throw existingInfraSecretError("Postgres", `${config.app.slug}-postgres`, "NSTACK_POSTGRES_PASSWORD");
    }
    if (!existingPostgresId && generatedInfraSecrets.postgres) {
      safeGeneratedInfra.postgres = true;
      persistState();
    }
    nextState.dokploy.postgresId = await provider.ensurePostgres(environmentId, infra, {
      passwordGenerated: generatedInfraSecrets.postgres,
    });
    await provider.syncPostgresConnection(nextState.dokploy.postgresId, infra);
    nextState.infra = infra;
    persistState();
  }
  if (resources.caches.length > 0) {
    const existingRedisId = nextState.dokploy.redisId || await provider.findRedisId(environmentId);
    if (existingRedisId && generatedInfraSecrets.redis) {
      throw existingInfraSecretError("Redis", `${config.app.slug}-redis`, "NSTACK_REDIS_PASSWORD");
    }
    if (!existingRedisId && generatedInfraSecrets.redis) {
      safeGeneratedInfra.redis = true;
      persistState();
    }
    nextState.dokploy.redisId = await provider.ensureRedis(environmentId, infra, {
      passwordGenerated: generatedInfraSecrets.redis,
    });
    await provider.syncRedisConnection(nextState.dokploy.redisId, infra);
    nextState.infra = infra;
    persistState();
  }

  infraText = renderEncoreInfra({ config, state: nextState, resources, infra, release, secretEnv });
  artifacts = deploymentArtifacts({ config, release, infraText, localContext: localOnly });
  images = artifacts.images;
  ctx = { config, state: nextState, resources, infra, images, build: artifacts.build, release, secretEnv };
  writeText(infraFile, infraText);
  writeText(composeFile, renderDokployCompose(ctx));

  const composeSource = await provider.resolveComposeSource();
  const composeId = await provider.upsertCompose(
    environmentId,
    renderDokployCompose({ ...ctx, state: nextState }),
    renderComposeEnvironment({
      resources,
      infra,
      secretEnv,
      buildEnv: composeBuildValues({ config, release, infraText, source: composeSource }),
    }),
    { source: composeSource },
  );
  nextState.dokploy.composeId = composeId;
  persistFullState();

  nextState.dokploy.schedules = await provider.syncSchedules(composeId, resources.crons, {
    prune: resources.source === "encore-metadata",
  });
  persistFullState();

  await provider.ensureDomains(composeId);
  nextState.lastAttempt = releaseAttempt(release, { status: "triggering" });
  persistFullState();

  try {
    await provider.deploy(composeId, release);
    nextState.lastAttempt = releaseAttempt(release, {
      status: "triggered",
      triggeredAt: nextState.lastAttempt.triggeredAt,
    });
    persistFullState();

    if (options.noWait) {
      const report = deploymentReport({
        mode: "deploy",
        config,
        resources,
        images,
        artifacts,
        release,
        infraFile,
        composeFile,
        releaseFile: fileExists(releaseFile) ? releaseFile : "",
        state: nextState,
      });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printTriggered({ config, release });
      return report;
    }

    await runReleaseChecks(cwd, config, release, options);
  } catch (error) {
    nextState.lastAttempt = releaseAttempt(release, {
      status: "failed",
      error: summarizeError(error),
      triggeredAt: nextState.lastAttempt.triggeredAt,
      failedAt: new Date().toISOString(),
    });
    persistFullState();
    throw error;
  }

  finalizeReleaseState(nextState, release, options, {
    triggeredAt: nextState.lastAttempt.triggeredAt,
  });
  persistFullState();

  const report = deploymentReport({
    mode: "deploy",
    config,
    resources,
    images,
    artifacts,
    release,
    infraFile,
    composeFile,
    releaseFile: fileExists(releaseFile) ? releaseFile : "",
    state: nextState,
    timings,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printDeployResult({ config, release, state: nextState });
  return report;
}

export async function waitForDeployment(options = {}) {
  const cwd = options.cwd || process.cwd();
  assertWaitCanPromote(options);
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  const release = releaseFromState(state);

  await runReleaseChecks(cwd, config, release, options);

  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
  };
  finalizeReleaseState(nextState, release, options, {
    triggeredAt: state.lastAttempt?.triggeredAt,
  });
  saveState(nextState, cwd, config.deploy.target);

  const report = waitReport({ config, release, state: nextState });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printWait({ config, release });
  return report;
}

export async function redeploy(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  const release = releaseFromState(state);
  const composeId = state.dokploy?.composeId || "";
  if (!composeId) {
    throw new Error("No Dokploy compose ID saved. Run `nstack pull` or `nstack deploy` first.");
  }
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }

  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
  };
  const provider = new DokployProvider({ config, state: nextState });
  await provider.redeploy(composeId, release);
  nextState.lastAttempt = releaseAttempt(release, { status: "triggered" });
  saveState(nextState, cwd, config.deploy.target);

  if (options.noWait) {
    const report = redeployReport({ config, release, state: nextState });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printRedeployTriggered({ config, release });
    return report;
  }

  try {
    await runReleaseChecks(cwd, config, release, options);
    finalizeReleaseState(nextState, release, options, {
      triggeredAt: nextState.lastAttempt.triggeredAt,
    });
    saveState(nextState, cwd, config.deploy.target);
  } catch (error) {
    nextState.lastAttempt = releaseAttempt(release, {
      status: "failed",
      error: summarizeError(error),
      triggeredAt: nextState.lastAttempt.triggeredAt,
      failedAt: new Date().toISOString(),
    });
    saveState(nextState, cwd, config.deploy.target);
    throw error;
  }

  const report = redeployReport({ config, release, state: nextState });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printRedeployVerified({ config, release });
  return report;
}

export async function syncEnvironment(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  const composeId = state.dokploy?.composeId || "";
  if (!composeId) {
    throw new Error("No Dokploy compose ID saved. Run `nstack pull` or `nstack deploy` first.");
  }
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }
  const release = options.stage ? null : releaseFromState(state);
  const resources = await inspectResources(cwd, config);
  const infra = infraFromStateForEnvPush({ config, resources, state });
  const secretEnv = await completeRemoteSecretEnv(resources, cwd, options, config.deploy.target);
  const envValues = composeEnvironmentValues({ resources, infra, secretEnv });
  const env = renderComposeEnvironment({ resources, infra, secretEnv });
  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
    lastEnvPush: {
      pushedAt: new Date().toISOString(),
      mode: options.all ? "all" : "declared",
      keys: Object.keys(envValues).sort(),
      staged: Boolean(options.stage),
    },
  };
  const provider = new DokployProvider({ config, state: nextState });
  await provider.saveComposeEnvironment(composeId, env);
  saveState(nextState, cwd, config.deploy.target);

  if (options.stage) {
    const report = envPushReport({ config, resources, release: null, state: nextState });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printEnvPushStaged({ config, report });
    return report;
  }

  try {
    await provider.redeploy(composeId, release);
    nextState.lastAttempt = releaseAttempt(release, { status: "triggered", envPush: true });
    saveState(nextState, cwd, config.deploy.target);

    if (options.noWait) {
      const report = envPushReport({ config, resources, release, state: nextState });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printEnvPushTriggered({ config, release, report });
      return report;
    }

    await runReleaseChecks(cwd, config, release, options);
    finalizeReleaseState(nextState, release, options, {
      triggeredAt: nextState.lastAttempt.triggeredAt,
      envPush: true,
    });
    saveState(nextState, cwd, config.deploy.target);
  } catch (error) {
    nextState.lastAttempt = releaseAttempt(release, {
      status: "failed",
      envPush: true,
      error: summarizeError(error),
      triggeredAt: nextState.lastAttempt?.triggeredAt,
      failedAt: new Date().toISOString(),
    });
    saveState(nextState, cwd, config.deploy.target);
    throw error;
  }

  const report = envPushReport({ config, resources, release, state: nextState });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printEnvPushVerified({ config, release, report });
  return report;
}

export async function rollback(args = [], options = {}) {
  if (!Array.isArray(args)) {
    options = args || {};
    args = [];
  }
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  const release = selectRollbackRelease(state, options.to || args[0] || "");
  const fromRelease = normalizeReleaseEntry(state.lastRelease);
  const composeId = state.dokploy?.composeId || "";
  const environmentId = state.dokploy?.environmentId || "";
  if (!composeId) {
    throw new Error("No Dokploy compose ID saved. Run `nstack pull` or `nstack deploy` first.");
  }
  if (!environmentId) {
    throw new Error("No Dokploy environment ID saved. Run `nstack pull` before rollback.");
  }
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }

  const resources = await inspectResources(cwd, config);
  const infra = infraFromStateForEnvPush({ config, resources, state });
  const infraText = renderEncoreInfra({ config, state, resources, infra, release, secretEnv: {} });
  const artifacts = deploymentArtifacts({ config, release, infraText, localContext: false });
  const images = artifacts.images;
  const composeFile = renderDokployCompose({ config, state, resources, images, build: artifacts.build, release });
  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
  };
  const provider = new DokployProvider({ config, state: nextState });
  await provider.updateComposeFile(environmentId, composeId, composeFile);
  nextState.lastAttempt = releaseAttempt(release, rollbackAttemptDetails({
    status: "triggering",
    fromRelease,
  }));
  saveState(nextState, cwd, config.deploy.target);

  try {
    await provider.deploy(composeId, release, {
      title: `nstack rollback ${release.tag}`,
      description: `Rollback to ${release.commit}`,
    });
    nextState.lastAttempt = releaseAttempt(release, rollbackAttemptDetails({
      status: "triggered",
      fromRelease,
      triggeredAt: nextState.lastAttempt.triggeredAt,
    }));
    saveState(nextState, cwd, config.deploy.target);

    if (options.noWait) {
      const report = rollbackReport({ config, release, fromRelease, state: nextState });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printRollbackTriggered({ config, release, fromRelease });
      return report;
    }

    await runReleaseChecks(cwd, config, release, options);
    finalizeReleaseState(nextState, release, options, rollbackAttemptDetails({
      fromRelease,
      triggeredAt: nextState.lastAttempt.triggeredAt,
    }));
    saveState(nextState, cwd, config.deploy.target);
  } catch (error) {
    nextState.lastAttempt = releaseAttempt(release, rollbackAttemptDetails({
      status: "failed",
      error: summarizeError(error),
      fromRelease,
      triggeredAt: nextState.lastAttempt.triggeredAt,
      failedAt: new Date().toISOString(),
    }));
    saveState(nextState, cwd, config.deploy.target);
    throw error;
  }

  const report = rollbackReport({ config, release, fromRelease, state: nextState });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printRollbackVerified({ config, release, fromRelease });
  return report;
}

function assertPreflight(command, report, options = {}) {
  const error = preflightError(command, preflightFailures(report, command, options));
  if (error) throw error;
}

function stateForSafeSave(state, generated, safeGenerated) {
  const next = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
    infra: { ...(state.infra || {}) },
  };
  if (generated.postgres && !safeGenerated.postgres) delete next.infra.postgres;
  if (generated.redis && !safeGenerated.redis) delete next.infra.redis;
  if (Object.keys(next.infra).length === 0) delete next.infra;
  return next;
}

function releaseAttempt(release, details = {}) {
  return {
    ...release,
    ...details,
    triggeredAt: details.triggeredAt || release.triggeredAt || new Date().toISOString(),
  };
}

function summarizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function runReleaseChecks(cwd, config, release, options = {}) {
  if (!options.skipVerify) {
    await verify({ config, release, quiet: options.json });
  }
  if (!options.skipStatus) {
    await auditPostDeployStatus(cwd, {
      target: config.deploy.target,
      timeoutMs: options.statusTimeoutMs,
      intervalMs: options.statusIntervalMs,
      timeoutSeconds: config.verify.timeoutSeconds,
      quiet: options.json,
    });
  }
}

function assertWaitCanPromote(options = {}) {
  if (!options.skipVerify) return;
  throw new Error("nstack wait cannot promote a release with --skip-verify. Use `nstack status --check --json` for a read-only Dokploy convergence check.");
}

function finalizeReleaseState(state, release, options = {}, details = {}) {
  const publicVerified = !options.skipVerify;
  const statusAudited = !options.skipStatus;
  const finishedAt = new Date().toISOString();
  if (publicVerified) {
    recordVerifiedRelease(state, release, { verifiedAt: finishedAt });
    state.lastRelease = release;
  }
  state.lastAttempt = releaseAttempt(release, {
    ...details,
    status: publicVerified ? "verified" : statusAudited ? "audited" : "triggered",
    checks: {
      public: publicVerified ? "passed" : "skipped",
      dokploy: statusAudited ? "passed" : "skipped",
    },
    ...(publicVerified ? { verifiedAt: finishedAt } : {}),
    ...(statusAudited ? { statusCheckedAt: finishedAt } : {}),
  });
}

function rollbackAttemptDetails({ fromRelease = null, ...details } = {}) {
  return {
    ...details,
    rollback: true,
    ...(fromRelease ? { rollbackFrom: fromRelease } : {}),
  };
}

function recordVerifiedRelease(state, release, details = {}) {
  const next = [];
  const seen = new Set();
  const add = (value, extra = {}) => {
    const normalized = normalizeReleaseEntry(value);
    if (!normalized) return;
    const key = releaseKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    next.push({
      ...normalized,
      ...extra,
    });
  };

  add(release, details.verifiedAt ? { verifiedAt: details.verifiedAt } : {});
  for (const entry of releaseHistory(state)) add(entry);
  state.releases = next.slice(0, maxReleaseHistory);
}

function selectRollbackRelease(state, ref = "") {
  const releases = releaseHistory(state);
  if (ref) {
    const found = releases.find((release) => releaseMatchesRef(release, ref));
    if (!found) {
      throw new Error(`No verified release matching "${ref}" is saved locally. Run \`nstack status --json\` to inspect saved releases.`);
    }
    return releaseShape(found);
  }

  const current = normalizeReleaseEntry(state.lastRelease);
  const previous = releases.find((release) => !current || releaseKey(release) !== releaseKey(current));
  if (!previous) {
    throw new Error("No previous verified release is saved locally. Run `nstack deploy` after a verified release, or pass an explicit saved tag to `nstack rollback <tag>`.");
  }
  return releaseShape(previous);
}

function releaseHistory(state) {
  const entries = [];
  const seen = new Set();
  const add = (value) => {
    const normalized = normalizeReleaseEntry(value);
    if (!normalized) return;
    const key = releaseKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(normalized);
  };

  for (const entry of Array.isArray(state.releases) ? state.releases : []) add(entry);
  add(state.lastRelease);
  if (state.lastAttempt?.status === "verified") add(state.lastAttempt);
  return entries;
}

function normalizeReleaseEntry(entry) {
  const source = entry?.release && typeof entry.release === "object" ? entry.release : entry;
  if (!source?.tag || !source?.commit) return null;
  return {
    commit: String(source.commit),
    tag: String(source.tag),
    builtAt: source.builtAt || entry?.builtAt || new Date().toISOString(),
    ...(source.verifiedAt || entry?.verifiedAt ? { verifiedAt: source.verifiedAt || entry.verifiedAt } : {}),
  };
}

function releaseShape(release) {
  return {
    commit: release.commit,
    tag: release.tag,
    builtAt: release.builtAt,
  };
}

function releaseKey(release) {
  return `${release.tag}\0${release.commit}`;
}

function releaseMatchesRef(release, ref) {
  return release.tag === ref || release.commit === ref || (ref.length >= 7 && release.commit.startsWith(ref));
}

function releaseFromState(state) {
  const source = state.lastAttempt || state.lastRelease;
  if (!source?.tag || !source?.commit) {
    throw new Error("No deployment attempt to wait for. Run `nstack deploy` or `nstack deploy --no-wait` first.");
  }
  return {
    commit: source.commit,
    tag: source.tag,
    builtAt: source.builtAt || new Date().toISOString(),
  };
}

async function auditPostDeployStatus(cwd, options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeoutSeconds * 1000 || 120_000);
  const intervalMs = Number(options.intervalMs || 3_000);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = null;

  for (;;) {
    const report = await createStatusReport({ cwd, target: options.target });
    const error = statusCheckError(report);
    if (!error) {
      if (!options.quiet) console.log("Post-deploy status: ok");
      return report;
    }
    lastError = error;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

async function completeAppSecrets(resources, cwd, options, target) {
  if (resources.secrets.length === 0) return {};
  const prompter = new Prompter({ yes: options.yes });
  const stored = parseDotEnv(readText(path.join(cwd, secretsEnvPathForTarget(target)), ""));
  const values = {};
  try {
    for (const name of resources.secrets) {
      values[name] = process.env[name] || stored[name] || await prompter.ask(name, `Secret ${name}`, { secret: true });
    }
    mergeEnvFile(path.join(cwd, secretsEnvPathForTarget(target)), values);
    return values;
  } finally {
    prompter.close();
  }
}

async function completeRemoteSecretEnv(resources, cwd, options, target) {
  const declared = await completeAppSecrets(resources, cwd, options, target);
  if (!options.all) return declared;
  return {
    ...parseDotEnv(readText(path.join(cwd, secretsEnvPathForTarget(target)), "")),
    ...declared,
  };
}

function infraFromStateForEnvPush({ config, resources, state }) {
  const infra = state.infra || {};
  if (resources.databases.length > 0 && !infra.postgres?.password) {
    throw new Error("Missing local infrastructure state for NSTACK_POSTGRES_PASSWORD. Run `nstack pull` before `nstack env push`.");
  }
  if (resources.caches.length > 0 && !infra.redis?.password) {
    throw new Error("Missing local infrastructure state for NSTACK_REDIS_PASSWORD. Run `nstack pull` before `nstack env push`.");
  }
  return {
    postgres: {
      appName: infra.postgres?.appName || `${config.app.slug}-postgres`,
      host: infra.postgres?.host || `${config.app.slug}-postgres:5432`,
      database: infra.postgres?.database || defaultPostgresDatabase(config, resources),
      user: infra.postgres?.user || "nstack",
      password: infra.postgres?.password || "",
    },
    redis: {
      appName: infra.redis?.appName || `${config.app.slug}-redis`,
      host: infra.redis?.host || `${config.app.slug}-redis:6379`,
      password: infra.redis?.password || "",
    },
  };
}

async function completeDeployConfig(config, cwd, options) {
  const prompter = new Prompter({ yes: options.yes });
  const localOnly = options.renderOnly || options.dryRun || options.buildOnly;
  try {
    const target = normalizeTarget(targetFromOptions(options) || config.deploy.target);
    const domain = options.domain || config.app.domain || await prompter.ask("NSTACK_DOMAIN", "Domain already pointed at Dokploy");
    const buildMode = normalizeBuildMode(options.buildMode || config.deploy.buildMode, options.registry || config.deploy.registry);
    const registry = buildMode === "registry"
      ? options.registry || config.deploy.registry || await prompter.ask("NSTACK_REGISTRY", "Image registry prefix")
      : options.registry || config.deploy.registry || "";
    const repository = options.repository || config.deploy.source?.repository || inferGitRepository(cwd);
    const branch = options.branch || config.deploy.source?.branch || inferGitBranch(cwd);
    const url = options.dokployUrl || config.deploy.provider.url || (localOnly ? "" : await prompter.ask("DOKPLOY_URL", "Dokploy URL"));
    const apiKey = options.dokployApiKey || config.deploy.provider.apiKey || (localOnly ? "" : await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true }));
    const serverId = options.serverId || config.deploy.provider.serverId || process.env.DOKPLOY_SERVER_ID || "";
    const platform = normalizeTargetPlatform(options.platform || config.deploy.platform).value;
    const projectName = options.project || config.deploy.provider.projectName;
    const environmentName = options.environment || config.deploy.provider.environmentName;
    const values = {
      NSTACK_DOMAIN: domain,
      NSTACK_BUILD_MODE: buildMode,
      ...(registry ? { NSTACK_REGISTRY: registry } : {}),
      ...(repository ? { NSTACK_REPOSITORY: repository } : {}),
      ...(branch ? { NSTACK_BRANCH: branch } : {}),
      ...(url ? { DOKPLOY_URL: url } : {}),
      ...(apiKey ? { DOKPLOY_API_KEY: apiKey } : {}),
      ...(serverId ? { DOKPLOY_SERVER_ID: serverId } : {}),
      ...(target !== "prod" || options.target || options.env || process.env.NSTACK_TARGET ? { NSTACK_TARGET: target } : {}),
      ...(options.platform || process.env.NSTACK_PLATFORM ? { NSTACK_PLATFORM: platform } : {}),
      ...(options.project || process.env.DOKPLOY_PROJECT ? { DOKPLOY_PROJECT: projectName } : {}),
      ...(options.environment || process.env.DOKPLOY_ENVIRONMENT ? { DOKPLOY_ENVIRONMENT: environmentName } : {}),
    };
    mergeEnvFile(path.join(cwd, localEnvPathForTarget(target)), values);
    return {
      ...config,
      app: { ...config.app, domain },
      deploy: {
        ...config.deploy,
        target,
        buildMode,
        platform,
        registry,
        source: { repository, branch },
        provider: { ...config.deploy.provider, url, apiKey, serverId, projectName, environmentName },
      },
    };
  } finally {
    prompter.close();
  }
}

function inferGitRepository(cwd) {
  const origin = safeOutput("git", ["config", "--get", "remote.origin.url"], cwd).trim();
  if (!origin) return "";
  return normalizeGitRepositoryUrl(origin);
}

function inferGitBranch(cwd) {
  return safeOutput("git", ["branch", "--show-current"], cwd).trim();
}

function normalizeGitRepositoryUrl(value) {
  const text = String(value || "").trim();
  const ssh = text.match(/^git@([^:]+):(.+)$/);
  if (!ssh) return text;
  return `https://${ssh[1]}/${ssh[2]}`;
}

export async function verify({ config = null, release = null, cwd = process.cwd(), target = "", quiet = false, json = false } = {}) {
  const loadedConfig = config || await loadConfig(cwd, { target });
  const state = loadState(cwd, loadedConfig.deploy.target);
  const loadedRelease = release || state.lastAttempt || state.lastRelease || releaseInfo(loadedConfig, cwd);
  const base = `https://${loadedConfig.app.domain}`;
  const deadline = Date.now() + Math.max(0, loadedConfig.verify.timeoutSeconds * 1000);
  let report = null;
  for (;;) {
    report = await verifyReport(loadedConfig, loadedRelease, base);
    if (report.ok) {
      if (json && !quiet) console.log(JSON.stringify(report, null, 2));
      else if (!quiet) console.log(`Verified ${base}`);
      return report;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, remaining)));
  }
  if (json && !quiet) console.log(JSON.stringify(report, null, 2));
  throw verifyReportError(report, base);
}

async function verifyReport(config, release, base) {
  const endpoints = [];
  for (const endpoint of config.verify.endpoints) {
    endpoints.push(await verifyEndpoint(base, endpoint, release));
  }
  const failed = endpoints.find((endpoint) => !endpoint.ok);
  return {
    ok: !failed,
    checkedAt: new Date().toISOString(),
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: base,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
    },
    release,
    endpoints,
    error: failed?.error || null,
  };
}

async function verifyEndpoint(base, endpoint, release) {
  const startedAt = Date.now();
  const name = endpoint.name || endpoint.path;
  const expectStatus = endpoint.expectStatus || 200;
  const url = `${base}${endpoint.path}`;
  const result = {
    name,
    path: endpoint.path,
    url,
    expectStatus,
    status: null,
    ok: false,
    durationMs: 0,
    expectCommit: Boolean(endpoint.expectCommit),
    error: null,
  };
  try {
    const response = await fetch(url);
    result.status = response.status;
    if (response.status !== expectStatus) {
      result.error = `${name} returned HTTP ${response.status}`;
      return finishVerifyEndpoint(result, startedAt);
    }
    const text = await response.text();
    for (const rejected of endpoint.rejectText || []) {
      if (text.includes(rejected)) {
        result.error = `${name} contained rejected text: ${rejected}`;
        return finishVerifyEndpoint(result, startedAt);
      }
    }
    if (endpoint.expectCommit && release.commit && !text.includes(release.commit)) {
      result.error = `${name} did not contain commit ${release.commit}`;
      return finishVerifyEndpoint(result, startedAt);
    }
    result.ok = true;
    return finishVerifyEndpoint(result, startedAt);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return finishVerifyEndpoint(result, startedAt);
  }
}

function finishVerifyEndpoint(result, startedAt) {
  result.durationMs = Date.now() - startedAt;
  return result;
}

function verifyReportError(report, base) {
  if (report?.error) return new Error(report.error);
  return new Error(`Verification timed out for ${base}`);
}

function releaseInfo(config, cwd) {
  const commit = safeOutput("git", ["rev-parse", "HEAD"], cwd).trim() || "local";
  const short = commit === "local" ? "local" : commit.slice(0, 12);
  return {
    commit,
    tag: process.env.NSTACK_IMAGE_TAG || short,
    builtAt: new Date().toISOString(),
  };
}

function resolveRelease(config, cwd, options = {}) {
  if (options.prebuilt) return prebuiltRelease(config, cwd);
  return releaseInfo(config, cwd);
}

function prebuiltRelease(config, cwd) {
  const manifest = readReleaseManifest(cwd);
  const file = releaseManifestPath(cwd);
  if (!manifest) {
    throw new Error(`nstack deploy --prebuilt requires ${path.relative(cwd, file)}. Run \`nstack build\` first.`);
  }
  const problems = releaseManifestProblems(manifest, config);
  if (problems.length > 0) {
    throw new Error([
      `nstack deploy --prebuilt cannot use ${path.relative(cwd, file)}:`,
      ...problems.map((problem) => `  - ${problem}`),
      config.deploy.buildMode === "registry"
        ? "Run `nstack build` again for this target, or use `nstack deploy --skip-build` with NSTACK_IMAGE_TAG if you manage images yourself."
        : "Run `nstack build` again for this target, or deploy normally so Dokploy builds from source.",
    ].join("\n"));
  }
  return manifest.release;
}

function readReleaseManifest(cwd) {
  try {
    return readJSON(releaseManifestPath(cwd), null);
  } catch (error) {
    throw new Error(`Could not read ${path.relative(cwd, releaseManifestPath(cwd))}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseManifestPath(cwd) {
  return path.join(cwd, generatedDir, releaseManifestName);
}

function releaseManifest({ config, resources, images, release }) {
  return {
    schema: releaseManifestSchema,
    app: {
      slug: config.app.slug,
      domain: config.app.domain,
    },
    deploy: {
      target: config.deploy.target,
      buildMode: config.deploy.buildMode,
      registry: config.deploy.registry,
      source: {
        repository: config.deploy.source?.repository || "",
        branch: config.deploy.source?.branch || "",
      },
      platform: config.deploy.platform,
    },
    release,
    images,
    resources: {
      source: resources.source,
      databases: resources.databases.map((database) => database.name).sort(),
      caches: resources.caches.map((cache) => cache.name).sort(),
      topics: resources.topics.map((topic) => topic.name).sort(),
      buckets: resources.buckets.map((bucket) => bucket.name).sort(),
      crons: resources.crons.map((cron) => cron.name).sort(),
      secrets: resources.secrets,
    },
    artifacts: {
      infra: path.join(generatedDir, "encore.infra.json"),
      compose: path.join(generatedDir, "compose.dokploy.yaml"),
    },
  };
}

function writeReleaseManifest(file, manifest) {
  writeJSON(file, manifest);
}

function releaseManifestProblems(manifest, config) {
  if (!manifest || typeof manifest !== "object") return ["release manifest is empty or invalid."];
  const problems = [];
  if (manifest.schema !== releaseManifestSchema) problems.push(`schema is ${manifest.schema || "(missing)"}, expected ${releaseManifestSchema}.`);
  if (manifest.app?.slug !== config.app.slug) problems.push(`app slug is ${manifest.app?.slug || "(missing)"}, expected ${config.app.slug}.`);
  if (manifest.app?.domain !== config.app.domain) problems.push(`domain is ${manifest.app?.domain || "(missing)"}, expected ${config.app.domain}.`);
  if (manifest.deploy?.target !== config.deploy.target) problems.push(`target is ${manifest.deploy?.target || "(missing)"}, expected ${config.deploy.target}.`);
  if ((manifest.deploy?.buildMode || "registry") !== config.deploy.buildMode) problems.push(`build mode is ${manifest.deploy?.buildMode || "registry"}, expected ${config.deploy.buildMode}.`);
  if (config.deploy.buildMode === "registry" && manifest.deploy?.registry !== config.deploy.registry) problems.push(`registry is ${manifest.deploy?.registry || "(missing)"}, expected ${config.deploy.registry}.`);
  if (config.deploy.buildMode === "compose") {
    const repository = manifest.deploy?.source?.repository || "";
    if (repository !== (config.deploy.source?.repository || "")) problems.push(`source repository is ${repository || "(missing)"}, expected ${config.deploy.source?.repository || "(missing)"}.`);
  }
  if (manifest.deploy?.platform !== config.deploy.platform) problems.push(`platform is ${manifest.deploy?.platform || "(missing)"}, expected ${config.deploy.platform}.`);
  if (!manifest.release?.tag) problems.push("release tag is missing.");
  if (!manifest.release?.commit) problems.push("release commit is missing.");
  if (manifest.release?.tag && config.deploy.buildMode === "registry") {
    const expectedImages = imageNames(config, manifest.release);
    if (manifest.images?.backend !== expectedImages.backend) problems.push(`backend image is ${manifest.images?.backend || "(missing)"}, expected ${expectedImages.backend}.`);
    if (manifest.images?.frontend !== expectedImages.frontend) problems.push(`frontend image is ${manifest.images?.frontend || "(missing)"}, expected ${expectedImages.frontend}.`);
  }
  return problems;
}

function deploymentArtifacts({ config, release, infraText = "", localContext = false }) {
  if (config.deploy.buildMode === "registry") {
    return {
      mode: "registry",
      images: imageNames(config, release),
      build: null,
    };
  }
  const context = sourceBuildContext(config, release, { localContext });
  return {
    mode: "compose",
    images: {},
    build: {
      context,
      services: {
        backend: {
          dockerfile: config.paths.backendDockerfile,
          args: {
            ENCORE_INFRA_CONFIG_B64: "${ENCORE_INFRA_CONFIG_B64:?set ENCORE_INFRA_CONFIG_B64}",
            NSTACK_GIT_COMMIT: "${NSTACK_GIT_COMMIT:-local}",
            NSTACK_IMAGE_TAG: "${NSTACK_IMAGE_TAG:-local}",
          },
        },
        frontend: {
          dockerfile: config.paths.frontendDockerfile,
        },
      },
    },
  };
}

function sourceBuildContext(config, release, { localContext = false } = {}) {
  const repository = config.deploy.source?.repository || "";
  if (repository) return "${NSTACK_BUILD_CONTEXT:-../..}";
  if (!repository && localContext) return "../..";
  return ".";
}

function composeBuildValues({ config, release, infraText, source = null }) {
  return {
    ENCORE_INFRA_CONFIG_B64: Buffer.from(infraText).toString("base64"),
    NSTACK_BUILD_CONTEXT: source?.sourceType === "gitea"
      ? "../.."
      : sourceBuildContextForEnv(config, release),
    NSTACK_GIT_COMMIT: release.commit,
    NSTACK_IMAGE_TAG: release.tag,
  };
}

function sourceBuildContextForEnv(config, release) {
  const repository = config.deploy.source?.repository || "";
  if (!repository) return ".";
  if (repository.includes("#")) return repository;
  const ref = release.commit && release.commit !== "local"
    ? release.commit
    : config.deploy.source?.branch || "";
  return ref ? `${repository}#${ref}` : repository;
}

function safeOutput(command, args, cwd) {
  try {
    return commandOutput(command, args, { cwd });
  } catch {
    return "";
  }
}

function imageNames(config, release) {
  const registry = config.deploy.registry.replace(/\/+$/, "");
  if (!registry) throw new Error("Image registry prefix is required. Run `nstack configure --registry <prefix>` or set NSTACK_REGISTRY.");
  return {
    backend: `${registry}/backend:${release.tag}`,
    frontend: `${registry}/frontend:${release.tag}`,
  };
}

function ensureInfraSecrets({ config, resources, state }) {
  const existing = state.infra || {};
  const postgresName = `${config.app.slug}-postgres`;
  const redisName = `${config.app.slug}-redis`;
  return {
    postgres: {
      appName: postgresName,
      host: existing.postgres?.host || `${postgresName}:5432`,
      database: existing.postgres?.database || defaultPostgresDatabase(config, resources),
      user: existing.postgres?.user || "nstack",
      password: existing.postgres?.password || (resources.databases.length ? randomSecret(24) : ""),
    },
    redis: {
      appName: redisName,
      host: existing.redis?.host || `${redisName}:6379`,
      password: existing.redis?.password || (resources.caches.length ? randomSecret(24) : ""),
    },
  };
}

function defaultPostgresDatabase(config, resources) {
  if (resources.databases.length === 1 && resources.databases[0]?.name) return resources.databases[0].name;
  return config.app.slug.replaceAll("-", "_");
}

function buildOnlySecretEnv(resources, secretEnv) {
  return Object.fromEntries(resources.secrets.map((name) => [
    name,
    secretEnv[name] || process.env[name] || "nstack-build-placeholder",
  ]));
}

function buildArtifacts({ config, cwd, artifacts, images, infraFile, composeFile, composeEnv = {}, quiet = false, timings = null }) {
  if (artifacts.mode === "compose") {
    if (!quiet) console.log(`Building ${config.app.slug} with Docker Compose`);
    timed("compose: docker compose build", quiet, timings, () => run("docker", [
      "compose",
      "-f", composeFile,
      "build",
    ], { cwd, capture: quiet, env: { ...process.env, ...composeEnv } }));
    return;
  }
  buildImages({ config, cwd, images, infraFile, quiet, timings });
}

function buildImages({ config, cwd, images, infraFile, quiet = false, timings = null }) {
  const platform = normalizeTargetPlatform(config.deploy.platform);
  buildBackendImage({ config, cwd, image: images.backend, infraFile, platform, quiet, timings });

  if (!fileExists(path.join(cwd, config.paths.frontendDockerfile))) {
    throw new Error(`${config.paths.frontendDockerfile} not found.`);
  }
  if (!quiet) console.log(`Building frontend ${images.frontend}`);
  timed("frontend: docker build", quiet, timings, () => run("docker", [
    "build",
    "--platform",
    platform.value,
    "-t", images.frontend,
    "-f", config.paths.frontendDockerfile,
    config.paths.frontendContext || config.paths.frontend,
  ], { cwd, capture: quiet }));
  timed("frontend: docker push", quiet, timings, () => {
    run("docker", ["push", images.frontend], { cwd, capture: quiet });
  });
}

function deploymentReport({ mode, config, resources, images, artifacts = null, release, infraFile, composeFile, releaseFile = "", state = null, timings = [] }) {
  const report = {
    mode,
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: `https://${config.app.domain}`,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      buildMode: config.deploy.buildMode,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
      platform: config.deploy.platform,
    },
    release,
    images,
    build: artifacts?.mode === "compose" ? {
      mode: "compose",
      context: artifacts.build?.context || null,
    } : { mode: "registry" },
    resources: {
      services: resources.services.length,
      databases: resources.databases.map((database) => database.name).sort(),
      caches: resources.caches.map((cache) => cache.name).sort(),
      topics: resources.topics.map((topic) => topic.name).sort(),
      buckets: resources.buckets.map((bucket) => bucket.name).sort(),
      crons: resources.crons.map((cron) => cron.name).sort(),
      secrets: resources.secrets,
      source: resources.source,
    },
    artifacts: {
      infra: infraFile,
      compose: composeFile,
      ...(releaseFile ? { release: releaseFile } : {}),
    },
    state: state ? {
      projectId: state.dokploy?.projectId || null,
      environmentId: state.dokploy?.environmentId || null,
      composeId: state.dokploy?.composeId || null,
      postgresId: state.dokploy?.postgresId || null,
      redisId: state.dokploy?.redisId || null,
      scheduleCount: Object.keys(state.dokploy?.schedules || {}).length,
      lastRelease: state.lastRelease || null,
      lastAttempt: state.lastAttempt || null,
      lastEnvPush: state.lastEnvPush || null,
      releases: Array.isArray(state.releases) ? state.releases : [],
    } : null,
  };
  if (timings.length) report.timings = summarizeTimings(timings);
  return report;
}

function timed(label, quiet, timings, task) {
  const startedAt = performance.now();
  const result = task();
  const durationMs = performance.now() - startedAt;
  if (timings) timings.push({ name: label, ms: Math.round(durationMs) });
  if (!quiet) console.log(`${label}: ${(durationMs / 1000).toFixed(2)}s`);
  return result;
}

function summarizeTimings(timings) {
  const steps = timings.map((entry) => ({
    name: entry.name,
    ms: entry.ms,
    seconds: Number((entry.ms / 1000).toFixed(3)),
  }));
  return {
    total_ms: steps.reduce((sum, entry) => sum + entry.ms, 0),
    steps,
  };
}

function waitReport({ config, release, state }) {
  return {
    mode: "wait",
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: `https://${config.app.domain}`,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
    },
    release,
    state: {
      projectId: state.dokploy?.projectId || null,
      environmentId: state.dokploy?.environmentId || null,
      composeId: state.dokploy?.composeId || null,
      lastRelease: state.lastRelease || null,
      lastAttempt: state.lastAttempt || null,
      lastEnvPush: state.lastEnvPush || null,
      releases: Array.isArray(state.releases) ? state.releases : [],
    },
  };
}

function redeployReport({ config, release, state }) {
  return {
    mode: "redeploy",
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: `https://${config.app.domain}`,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
    },
    release,
    state: {
      composeId: state.dokploy?.composeId || null,
      lastRelease: state.lastRelease || null,
      lastAttempt: state.lastAttempt || null,
      lastEnvPush: state.lastEnvPush || null,
      releases: Array.isArray(state.releases) ? state.releases : [],
    },
  };
}

function rollbackReport({ config, release, fromRelease, state }) {
  return {
    mode: "rollback",
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: `https://${config.app.domain}`,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
    },
    release,
    rollbackFrom: fromRelease,
    state: {
      composeId: state.dokploy?.composeId || null,
      environmentId: state.dokploy?.environmentId || null,
      lastRelease: state.lastRelease || null,
      lastAttempt: state.lastAttempt || null,
      lastEnvPush: state.lastEnvPush || null,
      releases: Array.isArray(state.releases) ? state.releases : [],
    },
  };
}

function envPushReport({ config, resources, release, state }) {
  return {
    mode: "env-push",
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: `https://${config.app.domain}`,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
    },
    release,
    env: {
      mode: state.lastEnvPush?.mode || "declared",
      staged: Boolean(state.lastEnvPush?.staged),
      keys: state.lastEnvPush?.keys || [],
      declared: [...resources.secrets].sort(),
      pushedAt: state.lastEnvPush?.pushedAt || null,
    },
    state: {
      composeId: state.dokploy?.composeId || null,
      lastRelease: state.lastRelease || null,
      lastAttempt: state.lastAttempt || null,
      lastEnvPush: state.lastEnvPush || null,
    },
  };
}

function configureReport(config) {
  return {
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: config.app.domain ? `https://${config.app.domain}` : null,
    },
    deploy: {
      target: config.deploy.target,
      buildMode: config.deploy.buildMode,
      registry: config.deploy.registry || null,
      source: {
        repository: config.deploy.source?.repository || null,
        branch: config.deploy.source?.branch || null,
      },
      platform: config.deploy.platform,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
      dokployUrl: config.deploy.provider.url || null,
      dokployApiKeySet: Boolean(config.deploy.provider.apiKey),
      serverId: config.deploy.provider.serverId || null,
    },
    files: {
      localEnv: localEnvPathForTarget(config.deploy.target),
    },
  };
}

function printPlan({ config, resources, images, artifacts, release, infraFile, composeFile }) {
  console.log(`nstack plan for ${config.app.slug}`);
  console.log(`  domain: https://${config.app.domain}`);
  console.log(`  build mode: ${artifacts.mode}`);
  if (artifacts.mode === "registry") {
    console.log(`  backend image: ${images.backend}`);
    console.log(`  frontend image: ${images.frontend}`);
  } else {
    console.log(`  build context: ${artifacts.build.context}`);
  }
  console.log(`  release: ${release.commit}`);
  console.log(`  resources: services=${resources.services.length} dbs=${resources.databases.length} caches=${resources.caches.length} topics=${resources.topics.length} crons=${resources.crons.length}`);
  console.log(`  wrote ${path.relative(process.cwd(), infraFile)}`);
  console.log(`  wrote ${path.relative(process.cwd(), composeFile)}`);
}

function printBuild({ config, images, artifacts, release, infraFile, composeFile, releaseFile }) {
  console.log(`Built ${config.app.slug}`);
  console.log(`  build mode: ${artifacts.mode}`);
  if (artifacts.mode === "registry") {
    console.log(`  backend image: ${images.backend}`);
    console.log(`  frontend image: ${images.frontend}`);
  } else {
    console.log(`  build context: ${artifacts.build.context}`);
  }
  console.log(`  release: ${release.commit}`);
  console.log(`  wrote ${path.relative(process.cwd(), infraFile)}`);
  console.log(`  wrote ${path.relative(process.cwd(), composeFile)}`);
  console.log(`  wrote ${path.relative(process.cwd(), releaseFile)}`);
  console.log(`  next: nstack deploy${artifacts.mode === "registry" ? " --prebuilt" : ""}`);
}

function printTriggered({ config, release }) {
  console.log(`Deployment triggered for ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
  console.log("  next: nstack wait");
}

function printDeployResult({ config, release, state }) {
  if (state.lastAttempt?.status === "verified") {
    console.log(`Deployed ${config.app.slug}: https://${config.app.domain}`);
    return;
  }
  printTriggered({ config, release });
}

function printRedeployTriggered({ config, release }) {
  console.log(`Redeployment triggered for ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
  console.log("  next: nstack wait");
}

function printRedeployVerified({ config, release }) {
  console.log(`Redeployed ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
}

function printRollbackTriggered({ config, release, fromRelease }) {
  console.log(`Rollback triggered for ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
  if (fromRelease) console.log(`  from: ${fromRelease.commit}`);
  console.log("  next: nstack wait");
}

function printRollbackVerified({ config, release, fromRelease }) {
  console.log(`Rolled back ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
  if (fromRelease) console.log(`  from: ${fromRelease.commit}`);
}

function printEnvPushStaged({ config, report }) {
  console.log(`Pushed env for ${config.app.slug} (${report.env.keys.length} keys)`);
  console.log("  staged: yes");
  console.log("  next: nstack redeploy");
}

function printEnvPushTriggered({ config, release, report }) {
  console.log(`Pushed env and triggered redeploy for ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  keys: ${report.env.keys.length}`);
  console.log(`  release: ${release.commit}`);
  console.log("  next: nstack wait");
}

function printEnvPushVerified({ config, release, report }) {
  console.log(`Pushed env and redeployed ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  keys: ${report.env.keys.length}`);
  console.log(`  release: ${release.commit}`);
}

function printWait({ config, release }) {
  console.log(`Verified deployment for ${config.app.slug}: https://${config.app.domain}`);
  console.log(`  release: ${release.commit}`);
}
