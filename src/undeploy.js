import { performance } from "node:perf_hooks";
import { loadConfig, loadState, saveState, targetFromOptions } from "./config.js";
import { Prompter } from "./prompt.js";
import { DokployProvider } from "./providers/dokploy.js";

export async function undeploy(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  if (config.deploy.provider.type !== "dokploy") {
    throw new Error("nstack undeploy currently supports Dokploy targets only.");
  }
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }

  const provider = new DokployProvider({ config, state });
  const timings = [];
  if (!options.dryRun) await confirmUndeploy(config, state.dokploy || {}, options);
  const ids = await timed("dokploy: resolve resources", timings, () => resolveManagedIds(provider, config, state));
  const hasRemoteResource = Boolean(ids.composeId || ids.postgresId || ids.redisId || ids.projectId);

  const deleted = {
    domains: [],
    schedules: [],
    compose: false,
    postgres: false,
    redis: false,
    project: false,
  };
  const cleanup = {
    stoppedContainersPruned: false,
    unusedImagesPruned: false,
    unusedVolumesPruned: false,
    dockerBuilderCachePruned: false,
  };
  let projectRetainedReason = "";

  if (hasRemoteResource && !options.dryRun) {
    if (ids.composeId) {
      deleted.domains = await timed("dokploy: delete domains", timings, () => provider.deleteComposeDomains(ids.composeId));
      deleted.schedules = await timed("dokploy: delete schedules", timings, () =>
        provider.deleteComposeSchedules(ids.composeId, Object.values(state.dokploy?.schedules || {})));
      deleted.compose = await timed("dokploy: delete compose", timings, () =>
        provider.deleteCompose(ids.composeId, { deleteVolumes: true }));
    }
    if (ids.postgresId) {
      deleted.postgres = await timed("dokploy: remove postgres", timings, () => provider.removePostgres(ids.postgresId));
    }
    if (ids.redisId) {
      deleted.redis = await timed("dokploy: remove redis", timings, () => provider.removeRedis(ids.redisId));
    }
    if (ids.projectId) {
      const hasServices = await timed("dokploy: check project empty", timings, () => provider.projectHasServices(ids.projectId));
      if (hasServices) {
        projectRetainedReason = "project still contains non-nstack services";
      } else {
        const projectRemoved = await timed("dokploy: remove project", timings, () => provider.removeProject(ids.projectId));
        deleted.project = projectRemoved || !hasServices;
      }
    }
    cleanup.stoppedContainersPruned = Boolean(await timed("dokploy: prune stopped containers", timings, () => provider.cleanStoppedContainers()));
    cleanup.unusedImagesPruned = Boolean(await timed("dokploy: prune unused images", timings, () => provider.cleanUnusedImages()));
    cleanup.unusedVolumesPruned = Boolean(await timed("dokploy: prune unused volumes", timings, () => provider.cleanUnusedVolumes()));
    cleanup.dockerBuilderCachePruned = Boolean(await timed("dokploy: prune docker builder cache", timings, () => provider.cleanDockerBuilder()));
    saveState(undeployedState(state, ids, deleted), cwd, config.deploy.target);
  }

  const report = {
    app: {
      name: config.app.name,
      slug: config.app.slug,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
    },
    mode: options.dryRun ? "dry-run" : "undeploy",
    resolved: ids,
    deleted,
    cleanup,
    retained: {
      project: ids.projectId && !deleted.project ? ids.projectId : null,
      reason: projectRetainedReason || null,
    },
    noop: !hasRemoteResource,
    timings: summarizeTimings(timings),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  printUndeploy(report);
  return report;
}

async function resolveManagedIds(provider, config, state) {
  const current = state.dokploy || {};
  const projectId = current.projectId || await provider.findProjectByName(config.deploy.provider.projectName);
  const environmentId = current.environmentId || (projectId
    ? await provider.findEnvironmentByName(projectId, config.deploy.provider.environmentName)
    : "");
  return {
    projectId,
    environmentId,
    composeId: current.composeId || (environmentId ? await provider.findComposeId(environmentId) : ""),
    postgresId: current.postgresId || (environmentId ? await provider.findPostgresId(environmentId) : ""),
    redisId: current.redisId || (environmentId ? await provider.findRedisId(environmentId) : ""),
  };
}

async function confirmUndeploy(config, ids, options) {
  if (options.yes) return;
  if (process.stdin.isTTY !== true) {
    throw new Error("Refusing to undeploy without confirmation. Pass `--yes` to delete remote Dokploy resources.");
  }
  const prompter = new Prompter({ yes: false });
  try {
    const accepted = await prompter.confirm("NSTACK_UNDEPLOY_CONFIRM", [
      `Delete ${config.app.slug} from Dokploy target ${config.deploy.target}?`,
      ids.projectId ? `Project ${config.deploy.provider.projectName} will be removed if it is empty after service deletion.` : "",
    ].filter(Boolean).join(" "), { defaultValue: false });
    if (!accepted) throw new Error("Undeploy cancelled.");
  } finally {
    prompter.close();
  }
}

function undeployedState(state, ids, deleted) {
  const next = {
    ...state,
    dokploy: { ...(state.dokploy || {}) },
    lastUndeploy: {
      undeployedAt: new Date().toISOString(),
      deleted: {
        compose: deleted.compose ? ids.composeId : null,
        postgres: deleted.postgres ? ids.postgresId : null,
        redis: deleted.redis ? ids.redisId : null,
        project: deleted.project ? ids.projectId : null,
      },
    },
  };
  delete next.dokploy.composeId;
  delete next.dokploy.postgresId;
  delete next.dokploy.redisId;
  delete next.dokploy.schedules;
  if (deleted.project) {
    delete next.dokploy.projectId;
    delete next.dokploy.environmentId;
  }
  if (Object.keys(next.dokploy).length === 0) delete next.dokploy;
  delete next.lastRelease;
  delete next.lastAttempt;
  return next;
}

async function timed(name, timings, task) {
  const startedAt = performance.now();
  const result = await task();
  const ms = Math.round(performance.now() - startedAt);
  timings.push({ name, ms, seconds: Number((ms / 1000).toFixed(3)) });
  return result;
}

function summarizeTimings(timings) {
  return {
    total_ms: timings.reduce((sum, entry) => sum + entry.ms, 0),
    steps: timings,
  };
}

function printUndeploy(report) {
  if (report.noop) {
    console.log(`${report.app.slug}: nothing to undeploy`);
    return;
  }
  const action = report.mode === "dry-run" ? "Would undeploy" : "Undeployed";
  console.log(`${action} ${report.app.slug} (${report.deploy.target})`);
  console.log(`  compose: ${report.resolved.composeId || "(none)"}${report.deleted.compose ? " deleted" : ""}`);
  console.log(`  postgres: ${report.resolved.postgresId || "(none)"}${report.deleted.postgres ? " deleted" : ""}`);
  console.log(`  redis: ${report.resolved.redisId || "(none)"}${report.deleted.redis ? " deleted" : ""}`);
  console.log(`  domains: ${report.deleted.domains.length}`);
  console.log(`  schedules: ${report.deleted.schedules.length}`);
  console.log(`  project: ${report.deleted.project ? "deleted" : report.retained.reason || "kept"}`);
  console.log(`  docker cleanup: ${report.cleanup.dockerBuilderCachePruned ? "done" : "skipped"}`);
  console.log(`  time: ${(report.timings.total_ms / 1000).toFixed(2)}s`);
}
