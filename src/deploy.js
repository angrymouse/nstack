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
import { createProgress } from "./progress.js";
import {
  DokployClient,
  DokployProvider,
  existingInfraSecretError,
  loadDokploySourceProviders,
  resolveComposeSourceConfig,
  sourceRefLabelForConfig,
} from "./providers/dokploy.js";
import { promptDokployInstance } from "./dokploy-instances.js";
import {
  OBJECT_STORAGE_ACCESS_ENV,
  OBJECT_STORAGE_SECRET_ENV,
  objectStorageInfra,
  objectStorageServiceHost,
} from "./object-storage.js";
import { renderDokployCompose } from "./render/compose.js";
import { renderEncoreInfra } from "./render/infra.js";
import { Prompter } from "./prompt.js";
import { createStatusReport, statusCheckError } from "./status.js";
import { ensureDir, fileExists, randomSecret, run, commandOutput, writeText, mergeEnvFile, parseDotEnv, readText, readJSON, writeJSON } from "./util.js";

const releaseManifestName = "release.json";
const releaseManifestSchema = "nstack.release.v1";
const maxReleaseHistory = 20;
const defaultValidationPollMs = 100;
const maxValidationPollMs = 250;
const defaultEndpointRequestTimeoutMs = 2000;
const encoreBackendGitignorePath = "backend/.gitignore";
const encoreBackendGitignoreText = "encore.gen.go\nencore.gen.cue\n/.encore\n/encore.gen\n";

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
  console.log("Next:");
  console.log("  nstack deploy");
  return report;
}

export async function deploy(options = {}) {
  const cwd = options.cwd || process.cwd();
  let config = await loadConfig(cwd, { target: targetFromOptions(options) });
  config = await completeDeployConfig(config, cwd, options);
  const state = loadState(cwd, config.deploy.target);
  const skipBuild = Boolean(options.skipBuild || options.prebuilt || config.deploy.buildMode === "compose");
  let release = resolveRelease(config, cwd, { ...options, skipBuild });
  const progress = createProgress({ enabled: !options.json && !options.renderOnly && !options.dryRun && !options.buildOnly });
  const resources = await progress.step("Inspecting Encore resources", () => inspectResources(cwd, config));
  const timings = [];
  const localOnly = options.renderOnly || options.dryRun || options.buildOnly;
  const command = options.buildOnly ? "build" : localOnly ? "render" : "deploy";
  const initialReport = await progress.step("Running local preflight checks", () => createDoctorReport({ cwd, config, state, resources }));
  assertPreflight(command, initialReport, {
    skipBuild,
    ignore: localOnly ? [] : ["app-secrets"],
  });
  if (!localOnly) {
    const remoteReport = await progress.step("Checking Dokploy access", () => createDoctorReport({ cwd, config, state, resources, checkRemote: true }));
    assertPreflight("deploy", remoteReport, {
      skipBuild,
      ignore: ["app-secrets"],
    });
  }
  const secretEnv = localOnly ? {} : await completeAppSecrets(resources, cwd, options, config.deploy.target);
  if (!localOnly) {
    const secretsReport = await progress.step("Checking app secrets", () => createDoctorReport({ cwd, config, state, resources }));
    assertPreflight("deploy", secretsReport, { skipBuild });
    const preflightProvider = new DokployProvider({ config, state });
    await progress.step("Validating DNS", () => timedAsync("dokploy: validate dns", true, timings, () => preflightProvider.validateAppDomain()));
    await progress.step("Enabling Dokploy cleanup", () => timedAsync("dokploy: enable docker cleanup", true, timings, () => preflightProvider.enableDockerCleanup()));
  }
  const infra = ensureInfraSecrets({ config, resources, state });
  const generatedInfraSecrets = {
    postgres: resources.databases.length > 0 && !state.infra?.postgres?.password,
    redis: resources.caches.length > 0 && !state.infra?.redis?.password,
    objectStorage: resources.buckets.length > 0 && (!state.infra?.objectStorage?.accessKey || !state.infra?.objectStorage?.secretKey),
  };
  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
    infra,
  };
  const safeGeneratedInfra = { postgres: false, redis: false, objectStorage: false };
  const persistState = () => saveState(
    stateForSafeSave(nextState, generatedInfraSecrets, safeGeneratedInfra),
    cwd,
    config.deploy.target,
  );
  const persistFullState = () => saveState(nextState, cwd, config.deploy.target);

  const infraFile = path.join(cwd, generatedDir, "encore.infra.json");
  const composeFile = path.join(cwd, generatedDir, "compose.dokploy.yaml");
  const releaseFile = releaseManifestPath(cwd);
  ensureDir(path.dirname(infraFile));
  let infraText = renderEncoreInfra({ config, state, resources, infra, release, secretEnv });
  let runtimeInfraText = renderEncoreInfra({ config, state, resources, infra, release, secretEnv, materializeSecrets: true });
  let artifacts = deploymentArtifacts({ config, release, infraText, localContext: localOnly });
  let images = artifacts.images;
  let ctx = { config, state, resources, infra, images, build: artifacts.build, release, secretEnv };
  const composeBuildEnv = composeEnvironmentValues({
    resources,
    infra,
    secretEnv: buildOnlySecretEnv(resources, secretEnv),
    buildEnv: composeBuildValues({ config, release, infraText: runtimeInfraText }),
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
    buildArtifacts({ config, cwd, resources, artifacts, images, infraFile, composeFile, composeEnv: composeBuildEnv, quiet: options.json, timings });
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
    await progress.step("Building registry images", async () => {
      buildArtifacts({ config, cwd, resources, artifacts, images, infraFile, composeFile, composeEnv: composeBuildEnv, quiet: options.json, timings });
    });
    writeReleaseManifest(releaseFile, releaseManifest({ config, resources, images, release, infraFile, composeFile }));
  }

  const provider = new DokployProvider({ config, state: nextState });
  const previousProjectId = nextState.dokploy.projectId || "";
  const projectId = await progress.step("Ensuring Dokploy project", () => provider.ensureProject());
  if (previousProjectId && previousProjectId !== projectId) clearDokployEnvironmentState(nextState.dokploy);
  nextState.dokploy.projectId = projectId;
  persistState();

  const previousEnvironmentId = nextState.dokploy.environmentId || "";
  const environmentId = await progress.step("Ensuring Dokploy environment", () => provider.ensureEnvironment(projectId));
  if (previousEnvironmentId && previousEnvironmentId !== environmentId) clearDokployResourceState(nextState.dokploy);
  nextState.dokploy.environmentId = environmentId;
  persistState();

  if (resources.buckets.length > 0) {
    await progress.step("Preparing object storage", async () => {
      const existingComposeId = await provider.resolveComposeId(environmentId);
      if (existingComposeId && generatedInfraSecrets.objectStorage) {
        const remoteEnv = await provider.readComposeEnvironment(existingComposeId);
        if (remoteEnv[OBJECT_STORAGE_ACCESS_ENV] || remoteEnv[OBJECT_STORAGE_SECRET_ENV]) {
          throw existingInfraSecretError("object storage service", objectStorageServiceHost(config), OBJECT_STORAGE_SECRET_ENV);
        }
      }
      if (generatedInfraSecrets.objectStorage) {
        safeGeneratedInfra.objectStorage = true;
        persistState();
      }
    });
  }

  if (resources.databases.length > 0) {
    await progress.step("Creating Postgres instances", async () => {
      const existingPostgresId = await provider.resolvePostgresId(environmentId);
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
    });
  }
  if (resources.caches.length > 0) {
    await progress.step("Creating Redis instances", async () => {
      const existingRedisId = await provider.resolveRedisId(environmentId);
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
    });
  }

  infraText = renderEncoreInfra({ config, state: nextState, resources, infra, release, secretEnv });
  runtimeInfraText = renderEncoreInfra({ config, state: nextState, resources, infra, release, secretEnv, materializeSecrets: true });
  artifacts = deploymentArtifacts({ config, release, infraText, localContext: localOnly });
  images = artifacts.images;
  ctx = { config, state: nextState, resources, infra, images, build: artifacts.build, release, secretEnv };
  writeText(infraFile, infraText);
  writeText(composeFile, renderDokployCompose(ctx));

  const composeSource = await progress.step("Resolving Git source", () => provider.resolveComposeSource());
  await maybeCommitSourceUserChanges(cwd, composeSource, options);
  const sourceSync = await progress.step("Pushing source repository", () => syncSourceDeployArtifacts(cwd, config, composeSource, timings));
  if (sourceSync.release) release = sourceSync.release;
  const composeId = await progress.step("Updating Dokploy Compose app", () => provider.upsertCompose(
      environmentId,
      renderDokployCompose({ ...ctx, state: nextState }),
      renderComposeEnvironment({
        resources,
        infra,
        secretEnv,
        buildEnv: composeBuildValues({ config, release, infraText: runtimeInfraText, source: composeSource }),
      }),
      { source: composeSource },
    ));
  nextState.dokploy.composeId = composeId;
  persistFullState();

  nextState.dokploy.schedules = await progress.step("Syncing Dokploy schedules", () => provider.syncSchedules(composeId, resources.crons, {
      prune: resources.source === "encore-metadata",
    }));
  persistFullState();

  await progress.step("Syncing Dokploy domains", () => provider.ensureDomains(composeId, resources));
  nextState.lastAttempt = releaseAttempt(release, { status: "triggering" });
  persistFullState();

  let checks = { deployment: null, timings: [] };
  try {
    await progress.step("Triggering Dokploy deployment", () => provider.deploy(composeId, release));
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

    checks = await progress.step("Verifying deployment", () => runReleaseChecks(cwd, config, release, options), { allowOutput: true });
    timings.push(...checks.timings);
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
    triggeredAt: deploymentTriggeredAt(checks.deployment) || nextState.lastAttempt.triggeredAt,
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

function clearDokployEnvironmentState(dokploy) {
  delete dokploy.environmentId;
  clearDokployResourceState(dokploy);
}

function clearDokployResourceState(dokploy) {
  delete dokploy.composeId;
  delete dokploy.postgresId;
  delete dokploy.redisId;
  delete dokploy.schedules;
}

export async function waitForDeployment(options = {}) {
  const cwd = options.cwd || process.cwd();
  assertWaitCanPromote(options);
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  const release = releaseForWait(config, cwd, state);

  const checks = await runReleaseChecks(cwd, config, release, {
    ...options,
    requireDeploymentMatch: isSourceBackedCompose(config) || options.requireDeploymentMatch,
  });
  const nextState = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
  };
  finalizeReleaseState(nextState, release, options, {
    triggeredAt: deploymentTriggeredAt(checks.deployment) || state.lastAttempt?.triggeredAt,
  });
  saveState(nextState, cwd, config.deploy.target);

  const report = waitReport({ config, release, state: nextState, timings: checks.timings });
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
  if (generated.objectStorage && !safeGenerated.objectStorage) delete next.infra.objectStorage;
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
  const timings = [];
  let deployment = null;
  let publicReport = null;
  let statusReport = null;
  let statusTask = null;
  const startStatusAudit = () => {
    if (statusTask) return statusTask;
    statusTask = timedAsync("dokploy: status audit", true, timings, () => auditPostDeployStatus(cwd, {
      target: config.deploy.target,
      timeoutMs: options.statusTimeoutMs,
      intervalMs: options.statusIntervalMs,
      timeoutSeconds: config.verify.timeoutSeconds,
      quiet: options.json,
    }));
    statusTask.catch(() => null);
    return statusTask;
  };
  const waitForDeploymentTask = async (signal) => {
    const result = await timedAsync("dokploy: wait deployment", true, timings, () => waitForDokployDeployment(cwd, config, release, {
      requireMatch: options.requireDeploymentMatch,
      timeoutMs: options.statusTimeoutMs || options.timeoutMs,
      intervalMs: options.statusIntervalMs || options.intervalMs,
      signal,
    }));
    startStatusAudit();
    return result;
  };
  const verifyTask = (signal) => timedAsync("verify: public endpoints", true, timings, () =>
    verify({
      config,
      release,
      cwd,
      quiet: options.json,
      intervalMs: options.verifyIntervalMs || options.statusIntervalMs || options.intervalMs,
      expectedCommit: expectedEndpointCommitForReleaseChecks(config, release, options),
      signal,
    }));

  if (!options.skipStatus && !options.skipVerify) {
    let results = null;
    try {
      results = await runConcurrentReleaseTasks({
        deployment: waitForDeploymentTask,
        publicReport: verifyTask,
      });
    } catch (error) {
      if (statusTask) await statusTask.catch(() => null);
      throw error;
    }
    deployment = results.deployment;
    publicReport = results.publicReport;
  } else {
    if (!options.skipStatus) deployment = await waitForDeploymentTask();
    if (!options.skipVerify) publicReport = await verifyTask();
  }
  if (!options.skipStatus) statusReport = await startStatusAudit();
  return { deployment, publicReport, statusReport, timings };
}

async function runConcurrentReleaseTasks(tasks) {
  const controller = new AbortController();
  let firstError = null;
  const entries = Object.entries(tasks);
  const settled = await Promise.allSettled(entries.map(async ([key, task]) => {
    try {
      return [key, await task(controller.signal)];
    } catch (error) {
      if (!firstError) {
        firstError = error;
        controller.abort(error);
      }
      throw error;
    }
  }));
  if (firstError) throw firstError;
  return Object.fromEntries(settled.map((result) => result.value));
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

function releaseForWait(config, cwd, state) {
  if (isSourceBackedCompose(config)) {
    const current = releaseInfo(config, cwd);
    if (current.commit && current.commit !== "local") return current;
  }
  return releaseFromState(state);
}

function deploymentForRelease(deployments, release) {
  return deployments.find((deployment) => deploymentMatchesRelease(deployment, release)) || null;
}

function deploymentMatchesRelease(deployment, release) {
  const text = [
    deployment?.id,
    deployment?.title,
    deployment?.description,
  ].filter(Boolean).join(" ").toLowerCase();
  const commit = String(release?.commit || "").toLowerCase();
  const tag = String(release?.tag || "").toLowerCase();
  return Boolean(
    (commit && commit !== "local" && text.includes(commit)) ||
    (tag && tag !== "local" && text.includes(tag)),
  );
}

function isActiveDeployment(deployment) {
  const status = String(deployment?.status || "").toLowerCase();
  return /running|queued?|building|deploying|pending|progress|processing|created|started/.test(status);
}

function isFailedDeployment(deployment) {
  const status = String(deployment?.status || "").toLowerCase();
  return /fail|error|cancel|killed|dead|terminated/.test(status);
}

function deploymentFailedError(deployment) {
  const error = new Error(`Dokploy deployment ${deployment?.id || deployment?.title || "latest"} failed with status ${deployment?.status || "unknown"}.`);
  error.code = "NSTACK_DOKPLOY_DEPLOYMENT_FAILED";
  return error;
}

function isDeploymentFailureError(error) {
  return error?.code === "NSTACK_DOKPLOY_DEPLOYMENT_FAILED";
}

function deploymentWaitTimeoutError({ release, deployments, error }) {
  const expected = [release?.commit, release?.tag].filter(Boolean).join(" / ") || "current release";
  const latest = deployments?.[0]
    ? `${deployments[0].id || deployments[0].title || "latest"} ${deployments[0].status || "unknown"} ${deployments[0].description || ""}`.trim()
    : "none";
  const detail = error ? ` Last Dokploy error: ${error instanceof Error ? error.message : String(error)}` : "";
  return new Error(`Timed out waiting for Dokploy deployment for ${expected}. Latest deployment: ${latest}.${detail}`);
}

function deploymentTriggeredAt(deployment) {
  return deployment?.startedAt || deployment?.createdAt || "";
}

function validationPollDelay(poll, baseIntervalMs = defaultValidationPollMs) {
  const base = Math.max(1, Number(baseIntervalMs) || defaultValidationPollMs);
  const multiplier = Math.min(4, 2 ** Math.max(0, poll));
  return Math.min(maxValidationPollMs, base * multiplier);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDokployDeployment(cwd, config, release, options = {}) {
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) return null;
  const state = loadState(cwd, config.deploy.target);
  const composeId = state.dokploy?.composeId || "";
  if (!composeId) return null;

  const provider = new DokployProvider({ config, state });
  const timeoutMs = Number(options.timeoutMs || config.verify.timeoutSeconds * 1000 || 120_000);
  const baseIntervalMs = Number(options.intervalMs || defaultValidationPollMs);
  const requireMatch = Boolean(options.requireMatch);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastDeployments = [];
  let lastError = null;
  let poll = 0;

  for (;;) {
    throwIfAborted(options.signal);
    try {
      lastDeployments = await provider.listComposeDeployments(composeId);
      const relevant = deploymentForRelease(lastDeployments, release);
      const active = lastDeployments.find(isActiveDeployment);
      const deployment = relevant || (requireMatch ? null : active);
      if (deployment) {
        if (isFailedDeployment(deployment)) throw deploymentFailedError(deployment);
        if (!isActiveDeployment(deployment)) return deployment;
      } else if (!requireMatch) {
        return null;
      }
    } catch (error) {
      if (isDeploymentFailureError(error)) throw error;
      lastError = error;
      if (!requireMatch) return null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw deploymentWaitTimeoutError({ release, deployments: lastDeployments, error: lastError });
    }
    await sleep(Math.min(validationPollDelay(poll++, baseIntervalMs), remaining), options.signal);
  }
}

async function auditPostDeployStatus(cwd, options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeoutSeconds * 1000 || 120_000);
  const intervalMs = Number(options.intervalMs || defaultValidationPollMs);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = null;
  let poll = 0;

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
    await sleep(Math.min(validationPollDelay(poll++, intervalMs), remaining));
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
  if (resources.buckets.length > 0 && (!infra.objectStorage?.accessKey || !infra.objectStorage?.secretKey)) {
    throw new Error(`Missing local infrastructure state for ${OBJECT_STORAGE_SECRET_ENV}. Run \`nstack pull\` before \`nstack env push\`.`);
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
    objectStorage: objectStorageInfra(config, infra.objectStorage),
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
    const credentials = await completeDokployCredentials({
      prompter,
      localOnly,
      url: options.dokployUrl || config.deploy.provider.url,
      apiKey: options.dokployApiKey || config.deploy.provider.apiKey,
    });
    const { url, apiKey } = credentials;
    const serverId = options.serverId || config.deploy.provider.serverId || process.env.DOKPLOY_SERVER_ID || "";
    const platform = normalizeTargetPlatform(options.platform || config.deploy.platform).value;
    const projectName = options.project || config.deploy.provider.projectName;
    const environmentName = options.environment || config.deploy.provider.environmentName;
    const source = await completeSourceConfig({
      buildMode,
      localOnly,
      source: sourceConfigFromOptions(config.deploy.source || {}, options),
      repository,
      branch,
      url,
      apiKey,
    });
    const values = {
      NSTACK_DOMAIN: domain,
      NSTACK_BUILD_MODE: buildMode,
      ...(registry ? { NSTACK_REGISTRY: registry } : {}),
      ...(repository ? { NSTACK_REPOSITORY: repository } : {}),
      ...(branch ? { NSTACK_BRANCH: branch } : {}),
      ...(source.sourceType ? { NSTACK_SOURCE_TYPE: source.sourceType } : {}),
      ...(source.githubId ? { NSTACK_GITHUB_ID: source.githubId } : {}),
      ...(source.gitlabId ? { NSTACK_GITLAB_ID: source.gitlabId } : {}),
      ...(source.bitbucketId ? { NSTACK_BITBUCKET_ID: source.bitbucketId } : {}),
      ...(source.giteaId ? { NSTACK_GITEA_ID: source.giteaId } : {}),
      ...(source.gitlabProjectId !== "" ? { NSTACK_GITLAB_PROJECT_ID: source.gitlabProjectId } : {}),
      ...(source.gitlabPathNamespace ? { NSTACK_GITLAB_PATH_NAMESPACE: source.gitlabPathNamespace } : {}),
      ...(source.bitbucketRepositorySlug ? { NSTACK_BITBUCKET_REPOSITORY_SLUG: source.bitbucketRepositorySlug } : {}),
      ...(source.sshKeyId ? { NSTACK_GIT_SSH_KEY_ID: source.sshKeyId } : {}),
      ...(source.composePath ? { NSTACK_COMPOSE_PATH: source.composePath } : {}),
      ...(source.watchPaths.length ? { NSTACK_WATCH_PATHS: source.watchPaths.join(",") } : {}),
      ...(url ? { DOKPLOY_URL: url } : {}),
      ...(apiKey ? { DOKPLOY_API_KEY: apiKey } : {}),
      ...(serverId ? { DOKPLOY_SERVER_ID: serverId } : {}),
      ...(target !== "prod" || options.target || options.env || process.env.NSTACK_TARGET ? { NSTACK_TARGET: target } : {}),
      ...(options.platform || process.env.NSTACK_PLATFORM ? { NSTACK_PLATFORM: platform } : {}),
      ...(options.project || process.env.DOKPLOY_PROJECT ? { DOKPLOY_PROJECT: projectName } : {}),
      ...(options.environment || process.env.DOKPLOY_ENVIRONMENT ? { DOKPLOY_ENVIRONMENT: environmentName } : {}),
    };
    mergeEnvFile(path.join(cwd, localEnvPathForTarget(target)), values);
    ensureGitOrigin(cwd, repository);
    return {
      ...config,
      app: { ...config.app, domain },
      deploy: {
        ...config.deploy,
        target,
        buildMode,
        platform,
        registry,
        source: { ...config.deploy.source, ...source, repository, branch },
        provider: { ...config.deploy.provider, url, apiKey, serverId, projectName, environmentName },
      },
    };
  } finally {
    prompter.close();
  }
}

async function completeDokployCredentials({ prompter, localOnly, url = "", apiKey = "" }) {
  if (url && apiKey) return { url, apiKey };
  if (localOnly) return { url, apiKey };
  const instance = await promptDokployInstance(prompter, { url, apiKey });
  return { url: instance.url, apiKey: instance.apiKey };
}

function sourceConfigFromOptions(existing, options) {
  return {
    sourceType: options.sourceType || existing.sourceType || "",
    githubId: options.githubId || existing.githubId || "",
    gitlabId: options.gitlabId || existing.gitlabId || "",
    bitbucketId: options.bitbucketId || existing.bitbucketId || "",
    giteaId: options.giteaId || existing.giteaId || "",
    gitlabProjectId: optionNumber(options.gitlabProjectId, existing.gitlabProjectId),
    gitlabPathNamespace: options.gitlabPathNamespace || existing.gitlabPathNamespace || "",
    bitbucketRepositorySlug: options.bitbucketRepositorySlug || existing.bitbucketRepositorySlug || "",
    sshKeyId: options.sshKeyId || existing.sshKeyId || "",
    composePath: options.composePath || existing.composePath || "",
    watchPaths: optionList(options.watchPaths, existing.watchPaths || []),
  };
}

function ensureGitOrigin(cwd, repository = "") {
  if (!repository) return;
  if (safeOutput("git", ["rev-parse", "--is-inside-work-tree"], cwd).trim() !== "true") return;
  const origin = safeOutput("git", ["remote", "get-url", "origin"], cwd).trim();
  if (!origin) run("git", ["remote", "add", "origin", repository], { cwd, capture: true });
}

async function completeSourceConfig({ buildMode, localOnly, source, repository, branch, url, apiKey }) {
  const base = { ...source, repository, branch };
  if (sourceConfigIsComplete(base)) return sourceDefaultsFromResolved(base, resolveComposeSourceConfig(base, []));
  if (buildMode !== "compose" || localOnly || !repository || !branch || !url || !apiKey) return source;

  const client = new DokployClient({ url, apiKey });
  const providers = await loadDokploySourceProviders(client);
  const resolved = resolveComposeSourceConfig(base, providers, { requireConfiguredProvider: true });
  return sourceDefaultsFromResolved(source, resolved);
}

function sourceConfigIsComplete(source) {
  if (source.sourceType === "raw") return true;
  if (source.sourceType === "git") return Boolean(source.repository && source.branch);
  return ["github", "gitlab", "bitbucket", "gitea"]
    .some((type) => source.sourceType === type && Boolean(source[`${type}Id`]));
}

function sourceDefaultsFromResolved(source, resolved) {
  if (!resolved) return source;
  return {
    ...source,
    sourceType: source.sourceType || resolved.sourceType,
    githubId: source.githubId || resolved.githubId || "",
    gitlabId: source.gitlabId || resolved.gitlabId || "",
    bitbucketId: source.bitbucketId || resolved.bitbucketId || "",
    giteaId: source.giteaId || resolved.giteaId || "",
    gitlabProjectId: source.gitlabProjectId || resolved.gitlabProjectId || "",
    gitlabPathNamespace: source.gitlabPathNamespace || resolved.gitlabPathNamespace || "",
    bitbucketRepositorySlug: source.bitbucketRepositorySlug || resolved.bitbucketRepositorySlug || "",
    sshKeyId: source.sshKeyId || resolved.sshKeyId || "",
    composePath: source.composePath || resolved.composePath || "",
    watchPaths: source.watchPaths.length ? source.watchPaths : resolved.watchPaths || [],
  };
}

function optionNumber(optionValue, existingValue) {
  const value = optionValue !== undefined && optionValue !== null && optionValue !== "" ? optionValue : existingValue;
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function optionList(optionValue, existingValue) {
  if (optionValue !== undefined && optionValue !== null && optionValue !== "") {
    return String(optionValue).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return Array.isArray(existingValue) ? existingValue.filter(Boolean).map(String) : [];
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

export async function verify({ config = null, release = null, cwd = process.cwd(), target = "", quiet = false, json = false, intervalMs = defaultValidationPollMs, expectedCommit = undefined, signal = null } = {}) {
  const loadedConfig = config || await loadConfig(cwd, { target });
  const state = loadState(cwd, loadedConfig.deploy.target);
  const loadedRelease = release || state.lastAttempt || state.lastRelease || releaseInfo(loadedConfig, cwd);
  const commitToExpect = expectedCommit ?? expectedVerifyCommit(loadedConfig, loadedRelease);
  const base = `https://${loadedConfig.app.domain}`;
  const deadline = Date.now() + Math.max(0, loadedConfig.verify.timeoutSeconds * 1000);
  let report = null;
  let poll = 0;
  for (;;) {
    throwIfAborted(signal);
    report = await verifyReport(loadedConfig, loadedRelease, base, {
      expectedCommit: commitToExpect,
      requestTimeoutMs: loadedConfig.verify.requestTimeoutMs,
      signal,
    });
    if (report.ok) {
      if (json && !quiet) console.log(JSON.stringify(report, null, 2));
      else if (!quiet) console.log(`Verified ${base}`);
      return report;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(validationPollDelay(poll++, intervalMs), remaining), signal);
  }
  if (json && !quiet) console.log(JSON.stringify(report, null, 2));
  throw verifyReportError(report, base);
}

async function verifyReport(config, release, base, options = {}) {
  const endpoints = await Promise.all(config.verify.endpoints
    .map((endpoint) => verifyEndpoint(base, endpoint, release, options)));
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

async function verifyEndpoint(base, endpoint, release, options = {}) {
  const startedAt = Date.now();
  const name = endpoint.name || endpoint.path;
  const expectStatus = endpoint.expectStatus || 200;
  const url = `${base}${endpoint.path}`;
  const expectedCommit = endpoint.expectCommit
    ? (options.expectedCommit !== undefined ? options.expectedCommit : release.commit || "")
    : "";
  const requestTimeoutMs = Number(endpoint.requestTimeoutMs ?? options.requestTimeoutMs ?? defaultEndpointRequestTimeoutMs);
  const result = {
    name,
    path: endpoint.path,
    url,
    expectStatus,
    status: null,
    ok: false,
    durationMs: 0,
    expectCommit: Boolean(endpoint.expectCommit),
    expectedCommit: expectedCommit || null,
    requestTimeoutMs: requestTimeoutMs > 0 ? requestTimeoutMs : null,
    error: null,
  };
  try {
    const response = await fetch(url, fetchOptionsForTimeout(requestTimeoutMs, options.signal));
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
    if (expectedCommit && !text.includes(expectedCommit)) {
      result.error = `${name} did not contain commit ${expectedCommit}`;
      return finishVerifyEndpoint(result, startedAt);
    }
    result.ok = true;
    return finishVerifyEndpoint(result, startedAt);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return finishVerifyEndpoint(result, startedAt);
  }
}

function fetchOptionsForTimeout(requestTimeoutMs, signal = null) {
  const signals = [];
  if (signal) signals.push(signal);
  if (requestTimeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    signals.push(AbortSignal.timeout(requestTimeoutMs));
  }
  if (signals.length === 0) return {};
  if (signals.length === 1) return { signal: signals[0] };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(signals) };
  }
  return { signal: signals[0] };
}

function expectedVerifyCommit(config, release) {
  if (!release?.commit) return "";
  if (isSourceBackedCompose(config) && release.commit === "local") {
    return sourceRefLabelForConfig(config.deploy.source) || release.commit;
  }
  return release.commit;
}

function expectedEndpointCommitForReleaseChecks(config, release, options = {}) {
  if (!options.skipStatus && isSourceBackedCompose(config)) return "";
  return expectedVerifyCommit(config, release);
}

function isSourceBackedCompose(config) {
  const sourceType = config.deploy.source?.sourceType || "";
  return config.deploy.buildMode === "compose" && Boolean(sourceType) && sourceType !== "raw";
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
  const sourceBacked = Boolean(source?.sourceType && source.sourceType !== "raw");
  return {
    ENCORE_INFRA_CONFIG_B64: Buffer.from(infraText).toString("base64"),
    NSTACK_BUILD_CONTEXT: sourceBacked
      ? "../.."
      : sourceBuildContextForEnv(config, release),
    NSTACK_GIT_COMMIT: sourceBacked ? sourceCommitValue(source, release) : release.commit,
    NSTACK_IMAGE_TAG: sourceBacked ? sourceImageTag(source) : release.tag,
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

function sourceRefLabel(source) {
  return source.refLabel || ([source.owner, source.repository].filter(Boolean).join("/")
    + (source.branch ? `@${source.branch}` : ""));
}

function sourceCommitValue(source, release) {
  if (release?.commit && release.commit !== "local") return release.commit;
  return sourceRefLabel(source) || release?.commit || "local";
}

function sourceImageTag(source) {
  const branch = String(source.branch || "branch")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "branch";
  return `source-${branch}`;
}

async function syncSourceDeployArtifacts(cwd, config, source = null, timings = []) {
  if (!source || source.sourceType === "raw") return { release: null };
  const repositoryUrl = config.deploy.source?.repository || source.repositoryUrl || "";
  if (repositoryUrl && safeOutput("git", ["rev-parse", "--is-inside-work-tree"], cwd).trim() !== "true") {
    await timedAsync("source: init git", true, timings, async () => {
      const branch = config.deploy.source?.branch || source.branch || "main";
      run("git", ["init"], { cwd, capture: true });
      run("git", ["checkout", "-B", branch], { cwd, capture: true });
      run("git", ["add", "."], { cwd, capture: true });
      const staged = safeOutput("git", ["diff", "--cached", "--name-only"], cwd).trim();
      if (staged) run("git", ["commit", "-m", "init"], { cwd, capture: true, env: gitCommitEnv() });
    });
  }
  let origin = safeOutput("git", ["config", "--get", "remote.origin.url"], cwd).trim();
  if (!origin && repositoryUrl) {
    await timedAsync("source: configure origin", true, timings, async () => {
      run("git", ["remote", "add", "origin", repositoryUrl], { cwd, capture: true });
    });
    origin = repositoryUrl;
  }
  if (!origin) return { release: null };

  const generatedChanges = sourceGeneratedChanges(cwd);
  const otherChanges = sourceOtherChanges(cwd);
  if (otherChanges.length > 0) {
    throw sourceUncommittedChangesError(otherChanges);
  }

  if (generatedChanges.length > 0) {
    await timedAsync("source: commit deploy artifacts", true, timings, async () => {
      run("git", ["add", "--", ...generatedChanges], { cwd, capture: true });
      const staged = safeOutput("git", ["diff", "--cached", "--name-only", "--", ...generatedChanges], cwd).trim();
      if (staged) run("git", ["commit", "-m", "Update nstack deploy artifacts"], { cwd, capture: true, env: gitCommitEnv() });
    });
  }

  await timedAsync("source: push", true, timings, async () => {
    try {
      const upstream = safeOutput("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd).trim();
      if (upstream) {
        run("git", ["push"], { cwd, capture: true });
        return;
      }
      const branch = config.deploy.source?.branch || source.branch || safeOutput("git", ["branch", "--show-current"], cwd).trim() || "main";
      pushInitialSourceBranch(cwd, branch);
    } catch (error) {
      throw sourcePushError({ cwd, config, source, error });
    }
  });

  return { release: releaseInfo(config, cwd) };
}

async function maybeCommitSourceUserChanges(cwd, source = null, options = {}) {
  if (!source || source.sourceType === "raw") return;
  const otherChanges = sourceOtherChanges(cwd);
  if (otherChanges.length === 0) return;
  if (options.json) throw sourceUncommittedChangesError(otherChanges);

  printSourceChanges(otherChanges);
  const prompter = new Prompter({ yes: options.yes });
  try {
    const shouldCommit = await prompter.confirm("NSTACK_COMMIT_UNSTAGED_CHANGES", "Commit all unstaged changes?", { defaultValue: false });
    if (!shouldCommit) throw sourceUncommittedChangesError(otherChanges, { declined: true });
    const message = await prompter.ask("NSTACK_COMMIT_MESSAGE", "Commit message");
    commitSourceUserChanges(cwd, otherChanges, message);
  } finally {
    prompter.close();
  }
}

function commitSourceUserChanges(cwd, files, message) {
  run("git", ["add", "--", ...files], { cwd, capture: true });
  const staged = safeOutput("git", ["diff", "--cached", "--name-only", "--", ...files], cwd).trim();
  if (!staged) return;
  run("git", ["commit", "-m", message], { cwd, capture: true, env: gitCommitEnv() });
}

function printSourceChanges(changes) {
  console.log("Source-backed deploy found uncommitted app changes:");
  for (const file of changes.slice(0, 8)) console.log(`  - ${file}`);
  if (changes.length > 8) console.log(`  - ${changes.length - 8} more`);
}

function sourceUncommittedChangesError(changes, { declined = false } = {}) {
  return new Error([
    declined
      ? "Source-backed deploy aborted because app changes were not committed."
      : "Source-backed deploy found uncommitted app changes.",
    "Commit or stash app changes first; nstack only auto-commits generated deploy artifacts.",
    ...changes.slice(0, 8).map((file) => `  - ${file}`),
    ...(changes.length > 8 ? [`  - ${changes.length - 8} more`] : []),
  ].join("\n"));
}

function pushInitialSourceBranch(cwd, branch) {
  const currentBranch = safeOutput("git", ["branch", "--show-current"], cwd).trim();
  if (currentBranch && currentBranch === branch) {
    run("git", ["push", "-u", "origin", currentBranch], { cwd, capture: true });
    return;
  }
  if (currentBranch) {
    run("git", ["push", "-u", "origin", `${currentBranch}:${branch}`], { cwd, capture: true });
    return;
  }
  run("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd, capture: true });
}

function sourcePushError({ cwd, config, source, error }) {
  const repository = config.deploy.source?.repository || source.repositoryUrl || "origin";
  const branch = config.deploy.source?.branch || source.branch || "main";
  const origin = safeOutput("git", ["remote", "get-url", "origin"], cwd).trim();
  return new Error([
    `Could not push source repository ${repository}.`,
    "Create a private repository on your Git provider if it does not exist, then push this app or fix your git credentials:",
    ...sourcePushRemoteRecovery(origin, repository).map((step) => `  ${step}`),
    "  git add .",
    "  git commit -m \"init\"",
    `  git push -u origin ${branch}`,
    "",
    `Git reported: ${summarizeError(error)}`,
  ].join("\n"), { cause: error });
}

function sourcePushRemoteRecovery(origin, repository) {
  if (!origin) return [`git remote add origin ${repository}`];
  if (origin !== repository) return [`git remote set-url origin ${repository}`];
  return [];
}

function gitCommitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "nstack",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "nstack@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "nstack",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "nstack@example.invalid",
  };
}

function sourceGeneratedChanges(cwd) {
  return gitPorcelainPaths(cwd).filter((file) => isGeneratedSourcePath(cwd, file));
}

function sourceOtherChanges(cwd) {
  return gitPorcelainPaths(cwd).filter((file) => !isGeneratedSourcePath(cwd, file) && !isLocalNstackPath(file));
}

function isLocalNstackPath(file) {
  return file === ".nstack" || file.startsWith(".nstack/");
}

function gitPorcelainPaths(cwd) {
  const text = safeOutput("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
  return text.split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(" -> ") ? file.split(" -> ").pop().trim() : file);
}

function isGeneratedDeployPath(file) {
  return file === generatedDir || file.startsWith(`${generatedDir}/`);
}

function isGeneratedSourcePath(cwd, file) {
  if (isGeneratedDeployPath(file)) return true;
  return file === encoreBackendGitignorePath
    && readText(path.join(cwd, file), "") === encoreBackendGitignoreText;
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
    objectStorage: objectStorageInfra(config, existing.objectStorage, {
      accessKey: existing.objectStorage?.accessKey || (resources.buckets.length ? randomSecret(16) : ""),
      secretKey: existing.objectStorage?.secretKey || (resources.buckets.length ? randomSecret(32) : ""),
    }),
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

function buildArtifacts({ config, cwd, resources, artifacts, images, infraFile, composeFile, composeEnv = {}, quiet = false, timings = null }) {
  if (artifacts.mode === "compose") {
    if (!quiet) console.log(`Building ${config.app.slug} with Docker Compose`);
    timed("compose: docker compose build", quiet, timings, () => run("docker", [
      "compose",
      "-f", composeFile,
      "build",
    ], { cwd, capture: quiet, env: { ...process.env, ...composeEnv } }));
    return;
  }
  buildImages({ config, cwd, resources, images, infraFile, quiet, timings });
}

function buildImages({ config, cwd, resources, images, infraFile, quiet = false, timings = null }) {
  const platform = normalizeTargetPlatform(config.deploy.platform);
  buildBackendImage({ config, cwd, image: images.backend, infraFile, platform, resources, quiet, timings });

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
  if (timings) timings.push({ name: label, ms: Math.round(durationMs), startedAt, endedAt: startedAt + durationMs });
  if (!quiet) console.log(`${label}: ${(durationMs / 1000).toFixed(2)}s`);
  return result;
}

async function timedAsync(label, quiet, timings, task) {
  const startedAt = performance.now();
  const result = await task();
  const durationMs = performance.now() - startedAt;
  if (timings) timings.push({ name: label, ms: Math.round(durationMs), startedAt, endedAt: startedAt + durationMs });
  if (!quiet) console.log(`${label}: ${(durationMs / 1000).toFixed(2)}s`);
  return result;
}

function summarizeTimings(timings) {
  const ordered = timings.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const steps = ordered.map((entry) => ({
    name: entry.name,
    ms: entry.ms,
    seconds: Number((entry.ms / 1000).toFixed(3)),
  }));
  const wallStartedAt = Math.min(...ordered.map((entry) => entry.startedAt).filter(Number.isFinite));
  const wallEndedAt = Math.max(...ordered.map((entry) => entry.endedAt).filter(Number.isFinite));
  const totalMs = Number.isFinite(wallStartedAt) && Number.isFinite(wallEndedAt)
    ? Math.round(wallEndedAt - wallStartedAt)
    : steps.reduce((sum, entry) => sum + entry.ms, 0);
  return {
    total_ms: totalMs,
    steps,
  };
}

function waitReport({ config, release, state, timings = [] }) {
  const report = {
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
  if (timings.length) report.timings = summarizeTimings(timings);
  return report;
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
  console.log(`  resources: services=${resources.services.length} dbs=${resources.databases.length} caches=${resources.caches.length} topics=${resources.topics.length} buckets=${resources.buckets.length} crons=${resources.crons.length}`);
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
