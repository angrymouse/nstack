import path from "node:path";
import { composeEnvironmentValues } from "./compose-env.js";
import { loadConfig, loadState, secretsEnvPathForTarget, targetFromOptions } from "./config.js";
import { discoverEncoreResources } from "./encore.js";
import { DokployProvider, expectedComposeDomains, expectedComposeSchedules } from "./providers/dokploy.js";
import { parseDotEnv, readText } from "./util.js";

export async function showStatus(options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = await createStatusReport({ cwd, target: targetFromOptions(options) });
  const ok = statusOk(report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (options.check && !ok) process.exitCode = 1;
    return report;
  }

  printStatus(report);
  if (options.check && !ok) process.exitCode = 1;
  return report;
}

export async function createStatusReport({ cwd = process.cwd(), target = "" } = {}) {
  const config = await loadConfig(cwd, { target });
  const state = loadState(cwd, config.deploy.target);
  const resources = await discoverResources(cwd, config);
  const remote = await remoteStatus(config, state);
  const report = {
    app: {
      name: config.app.name,
      slug: config.app.slug,
      url: config.app.domain ? `https://${config.app.domain}` : null,
    },
    deploy: {
      target: config.deploy.target,
      buildMode: config.deploy.buildMode,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
      dokployUrl: config.deploy.provider.url || null,
      source: {
        repository: config.deploy.source?.repository || null,
        branch: config.deploy.source?.branch || null,
      },
      linked: Boolean(config.deploy.provider.url && config.deploy.provider.apiKey),
    },
    state: {
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
    },
    resources: summarizeResources(resources),
    remote,
  };
  report.drift = analyzeDrift({ config, state, resources, remote: report.remote, cwd });
  report.nextSteps = statusNextSteps(report);
  return report;
}

export function statusOk(report) {
  return report.remote.ok && report.drift.ok;
}

export function statusCheckError(report) {
  if (statusOk(report)) return null;
  const nextSteps = report.nextSteps || [];
  const issues = [
    ...(report.remote.ok ? [] : [report.remote.reason || "Remote Dokploy status could not be fully read."]),
    ...report.drift.issues,
  ];
  return new Error([
    "nstack deploy post-deploy status audit failed:",
    ...[...new Set(issues)].map((issue) => `  - ${issue}`),
    "Next steps:",
    ...(nextSteps.length > 0
      ? nextSteps.map((step) => `  - ${step}`)
      : ["  - Run `nstack status --check --json` for the full report."]),
  ].join("\n"));
}

async function remoteStatus(config, state) {
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    return {
      ok: false,
      reason: "Missing Dokploy URL or API key. Run `nstack configure`.",
      compose: null,
      domains: [],
      schedules: [],
      deployments: [],
      health: null,
    };
  }
  const provider = new DokployProvider({ config, state });
  return provider.remoteStatus();
}

async function discoverResources(cwd, config) {
  try {
    return await discoverEncoreResources(path.join(cwd, config.paths.backend));
  } catch (error) {
    return {
      source: "error",
      metadataError: error instanceof Error ? error.message : String(error),
      services: [],
      databases: [],
      caches: [],
      topics: [],
      buckets: [],
      secrets: [],
      crons: [],
    };
  }
}

function summarizeResources(resources) {
  return {
    source: resources.source,
    metadataError: resources.metadataError || null,
    crons: resources.crons.map((cron) => cron.name).sort(),
    databases: resources.databases.map((database) => database.name).sort(),
    caches: resources.caches.map((cache) => cache.name).sort(),
    topics: resources.topics.map((topic) => topic.name).sort(),
    buckets: resources.buckets.map((bucket) => bucket.name).sort(),
  };
}

function printStatus(report) {
  console.log(`${report.app.slug}: ${statusOk(report) ? "ok" : "needs attention"}`);
  line("url", report.app.url);
  line("target", report.deploy.target);
  line("build mode", report.deploy.buildMode);
  line("release", releaseLine(report.state.lastRelease));
  if (report.state.lastAttempt && report.state.lastAttempt.status !== "verified") line("attempt", attemptLine(report.state.lastAttempt));
  if (report.state.lastEnvPush) line("env push", envPushLine(report.state.lastEnvPush));
  line("remote", remoteLine(report));
  const latest = (report.remote.deployments || [])[0];
  if (latest && (isActiveDeployment(latest) || isFailedDeployment(latest))) line("deployment", deploymentLine(latest));

  if (report.drift.issues.length > 0) {
    console.log("");
    console.log("issues:");
    for (const issue of report.drift.issues) console.log(`  ${issue}`);
  }

  console.log("");
  console.log("next:");
  if (report.nextSteps.length === 0) console.log("  none");
  else for (const step of report.nextSteps) console.log(`  ${step}`);

  if (report.remote.errors && Object.keys(report.remote.errors).length > 0) {
    console.log("");
    console.log("errors:");
    for (const [key, value] of Object.entries(report.remote.errors)) line(key, value, "  ");
  }
}

function line(name, value, prefix = "") {
  console.log(`${prefix}${name}: ${value === null || value === undefined || value === "" ? "(missing)" : value}`);
}

function releaseLine(release) {
  if (!release) return null;
  return [release.tag || release.commit, release.commit && release.commit !== release.tag ? release.commit : ""]
    .filter(Boolean)
    .join(" ");
}

function remoteLine(report) {
  if (report.remote.ok) return "ok";
  return report.remote.reason || "not ready";
}

function deploymentLine(deployment) {
  return `${deployment.id || "(missing)"} ${deployment.status || "(unknown)"} ${deployment.title || ""}`.trim();
}

function analyzeDrift({ config, state, resources, remote, cwd }) {
  const issues = [];
  const expectedDomains = expectedComposeDomains(config, state.dokploy?.composeId || "");
  const expectedSchedules = expectedSchedulesOrIssues(config, state.dokploy?.composeId || "", resources.crons, issues);
  const expectedImages = expectedReleaseImages(config, expectedReleaseForStatus(state));
  const expectedEnv = expectedComposeEnvForStatus({ cwd, config, resources, state, issues });

  if (resources.source === "error") {
    issues.push(`Could not inspect current Encore resources: ${resources.metadataError}`);
  }
  if (!remote.ok) {
    issues.push(remote.reason || "Remote Dokploy status could not be fully read.");
  }

  if (remote.reason) {
    return driftResult({ issues, expectedDomains, expectedSchedules, expectedImages, expectedEnv });
  }

  issues.push(...deploymentStateIssues(remote.deployments || []));

  for (const expected of expectedDomains) {
    const current = remote.domains.find((domain) =>
      domain.host === expected.host &&
      String(domain.path || "/") === expected.path &&
      domain.serviceName === expected.serviceName);
    if (!current) {
      issues.push(`Missing Dokploy domain ${expected.host}${expected.path} -> ${expected.serviceName}:${expected.port}.`);
      continue;
    }
    if (Number(current.port) !== Number(expected.port)) {
      issues.push(`Dokploy domain ${expected.host}${expected.path} points at port ${current.port}, expected ${expected.port}.`);
    }
    if (Boolean(current.stripPath) !== Boolean(expected.stripPath)) {
      issues.push(`Dokploy domain ${expected.host}${expected.path} stripPath is ${Boolean(current.stripPath)}, expected ${Boolean(expected.stripPath)}.`);
    }
  }

  const remoteSchedulesByName = new Map(remote.schedules.map((schedule) => [schedule.name, schedule]));
  for (const expected of expectedSchedules) {
    const current = remoteSchedulesByName.get(expected.name);
    if (!current) {
      issues.push(`Missing Dokploy schedule ${expected.name} (${expected.cronExpression}).`);
      continue;
    }
    if (current.cronExpression !== expected.cronExpression) {
      issues.push(`Dokploy schedule ${expected.name} uses ${current.cronExpression}, expected ${expected.cronExpression}.`);
    }
    if (current.enabled === false) {
      issues.push(`Dokploy schedule ${expected.name} is disabled.`);
    }
    if (current.serviceName && current.serviceName !== expected.serviceName) {
      issues.push(`Dokploy schedule ${expected.name} runs on service ${current.serviceName}, expected ${expected.serviceName}.`);
    }
    if (current.command !== null && current.command !== expected.command) {
      issues.push(`Dokploy schedule ${expected.name} command is out of sync with the Encore cron endpoint.`);
    }
  }

  const managedScheduleNames = new Set(expectedSchedules.map((schedule) => schedule.name));
  for (const schedule of remote.schedules) {
    if (schedule.name?.startsWith(`nstack-${config.app.slug}-`) && !managedScheduleNames.has(schedule.name)) {
      issues.push(`Stale Dokploy schedule ${schedule.name} is still present.`);
    }
  }

  if (expectedImages.length > 0 && remote.compose && remote.compose.ok !== false) {
    for (const image of expectedImages) {
      if (!remote.compose.images.includes(image)) {
        issues.push(`Remote Compose is not using expected image ${image}.`);
      }
    }
  }

  compareComposeEnv({ expectedEnv, remote, issues });

  return driftResult({ issues, expectedDomains, expectedSchedules, expectedImages, expectedEnv });
}

function driftResult({ issues, expectedDomains, expectedSchedules, expectedImages, expectedEnv }) {
  return {
    ok: issues.length === 0,
    issues,
    expected: {
      domains: expectedDomains.map((domain) => ({
        host: domain.host,
        path: domain.path,
        serviceName: domain.serviceName,
        port: domain.port,
        stripPath: domain.stripPath,
      })),
      schedules: expectedSchedules.map((schedule) => ({
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        serviceName: schedule.serviceName,
      })),
      images: expectedImages,
      envKeys: Object.keys(expectedEnv || {}).sort(),
    },
  };
}

function expectedSchedulesOrIssues(config, composeId, crons, issues) {
  try {
    return expectedComposeSchedules(config, composeId, crons).map(({ payload }) => payload);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return [];
  }
}

function expectedReleaseImages(config, release) {
  if (config.deploy.buildMode !== "registry" || !release?.tag || !config.deploy.registry) return [];
  const registry = config.deploy.registry.replace(/\/+$/, "");
  return [
    `${registry}/backend:${release.tag}`,
    `${registry}/frontend:${release.tag}`,
  ];
}

function expectedReleaseForStatus(state) {
  return state.lastAttempt || state.lastRelease;
}

function attemptLine(attempt) {
  const pieces = [attempt.status || "unknown", attempt.tag || attempt.commit || ""];
  if (attempt.error) pieces.push(attempt.error);
  return pieces.filter(Boolean).join(" ");
}

function envPushLine(envPush) {
  const pieces = [envPush.pushedAt || "", `${(envPush.keys || []).length} keys`];
  if (envPush.staged) pieces.push("staged");
  return pieces.filter(Boolean).join(" ");
}

function expectedComposeEnvForStatus({ cwd, config, resources, state, issues }) {
  const secretEnv = parseDotEnv(readText(path.join(cwd, secretsEnvPathForTarget(config.deploy.target)), ""));
  const infra = state.infra || {};
  const comparableSecretEnv = {};
  for (const secret of resources.secrets) {
    const value = process.env[secret] || secretEnv[secret] || "";
    if (!value) {
      issues.push(`Missing local app runtime secret ${secret}; run \`nstack env set ${secret}\`.`);
      continue;
    }
    comparableSecretEnv[secret] = value;
  }

  if (resources.databases.length > 0 && !infra.postgres?.password && hasRemoteInfraState(state, "postgres")) {
    issues.push("Missing local infrastructure state for NSTACK_POSTGRES_PASSWORD; run `nstack pull` to recover it from Dokploy before deploying.");
  }
  if (resources.caches.length > 0 && !infra.redis?.password && hasRemoteInfraState(state, "redis")) {
    issues.push("Missing local infrastructure state for NSTACK_REDIS_PASSWORD; run `nstack pull` to recover it from Dokploy before deploying.");
  }

  return composeEnvironmentValues({
    resources: {
      ...resources,
      databases: infra.postgres?.password ? resources.databases : [],
      caches: infra.redis?.password ? resources.caches : [],
    },
    infra: {
      postgres: { password: infra.postgres?.password || "" },
      redis: { password: infra.redis?.password || "" },
    },
    secretEnv: comparableSecretEnv,
  });
}

function hasRemoteInfraState(state, kind) {
  if (kind === "postgres") return Boolean(state.dokploy?.composeId || state.dokploy?.postgresId);
  if (kind === "redis") return Boolean(state.dokploy?.composeId || state.dokploy?.redisId);
  return Boolean(state.dokploy?.composeId);
}

function statusNextSteps(report) {
  const steps = [];
  const add = (step) => {
    if (step && !steps.includes(step)) steps.push(step);
  };

  if (!report.deploy.linked) {
    add("Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }
  if (!report.state.composeId) {
    add("Run `nstack pull` to recover an existing Dokploy app, or `nstack deploy` for a new target.");
  }

  for (const issue of report.drift.issues) {
    const missingSecret = issue.match(/Missing local app runtime secret ([A-Z0-9_]+)/);
    if (missingSecret) add(`Run \`nstack env set ${missingSecret[1]}\`.`);

    if (issue.includes("Missing local infrastructure state for NSTACK_")) {
      add("Run `nstack pull` to recover generated infrastructure secrets from Dokploy.");
    }
    if (
      issue.startsWith("Missing Dokploy domain ") ||
      issue.startsWith("Dokploy domain ") ||
      issue.startsWith("Missing Dokploy schedule ") ||
      issue.startsWith("Dokploy schedule ") ||
      issue.startsWith("Stale Dokploy schedule ") ||
      issue.startsWith("Remote Compose is not using expected image ")
    ) {
      add("Run `nstack deploy` to sync Dokploy with the current app.");
    }
    if (
      issue.startsWith("Missing Dokploy environment key ") ||
      issue.startsWith("Dokploy environment key ")
    ) {
      add("Run `nstack env push` to sync local app secrets to Dokploy and redeploy the current release.");
    }
    if (issue.startsWith("Could not inspect current Encore resources:")) {
      add("Run `nstack doctor` and fix Encore resource discovery.");
    }
    if (issue.startsWith("No Dokploy compose ID saved.")) {
      add("Run `nstack pull` or `nstack deploy` first.");
    }
    if (issue.startsWith("Latest Dokploy deployment ") && issue.includes(" failed")) {
      const latest = (report.remote.deployments || [])[0];
      if (latest?.id) add(`Run \`nstack logs ${latest.id}\` to inspect the failed deployment.`);
      add("Run `nstack redeploy` to retry the current saved release, or `nstack rollback` to return to the previous verified release.");
    }
  }

  if (!report.remote.ok && report.state.composeId) {
    add("Run `nstack deployments`, `nstack logs --follow`, or `nstack cancel` to inspect or stop recent Dokploy deployment attempts.");
  }
  const active = (report.remote.deployments || []).find(isActiveDeployment);
  if (active?.id) {
    add(`Run \`nstack logs ${active.id} --follow\` to follow the active deployment.`);
    add(`Run \`nstack cancel ${active.id}\` to stop it.`);
  }

  return steps;
}

function isActiveDeployment(deployment) {
  const status = String(deployment.status || "").toLowerCase();
  return /running|queued?|building|deploying|pending|progress|processing|created|started/.test(status);
}

function isFailedDeployment(deployment) {
  const status = String(deployment.status || "").toLowerCase();
  return /fail|error|cancel|killed|dead|terminated/.test(status);
}

function deploymentStateIssues(deployments = []) {
  const latest = deployments[0];
  if (!latest) return [];
  const label = latest.id || latest.title || "latest";
  const status = latest.status || "unknown";
  if (isActiveDeployment(latest)) {
    return [`Latest Dokploy deployment ${label} is still ${status}.`];
  }
  if (isFailedDeployment(latest)) {
    return [`Latest Dokploy deployment ${label} failed with status ${status}.`];
  }
  return [];
}

function compareComposeEnv({ expectedEnv, remote, issues }) {
  if (!remote.compose || remote.compose.ok === false) return;
  const remoteEnv = remote.compose.envValues || {};
  for (const [key, value] of Object.entries(expectedEnv)) {
    if (!(key in remoteEnv)) {
      issues.push(`Missing Dokploy environment key ${key}.`);
      continue;
    }
    if (String(remoteEnv[key]) !== String(value)) {
      issues.push(`Dokploy environment key ${key} differs from local state.`);
    }
  }
}
