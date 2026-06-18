import { loadConfig, loadState, targetFromOptions } from "./config.js";
import { DokployProvider } from "./providers/dokploy.js";

export async function listDeployments(options = {}) {
  const ctx = await deploymentContext(options);
  const allDeployments = await ctx.provider.listComposeDeployments(ctx.composeId);
  const statusFilter = parseStatusFilter(options.status);
  const limit = clampLimit(Number(options.limit || 0));
  const deployments = limitDeployments(filterDeployments(allDeployments, { statusFilter }), limit);
  const report = {
    app: ctx.config.app.slug,
    target: ctx.config.deploy.target,
    composeId: ctx.composeId,
    filters: {
      status: [...statusFilter],
      limit: limit || null,
    },
    total: allDeployments.length,
    count: deployments.length,
    deployments,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`deployments: ${ctx.config.app.slug} (${ctx.config.deploy.target})`);
  if (deployments.length === 0) {
    console.log("  none");
    return report;
  }
  for (const deployment of deployments) {
    console.log(`  ${deployment.id || "(missing)"} ${deployment.status || "(unknown)"} ${deployment.createdAt || ""} ${deployment.title || ""}`.trimEnd());
  }
  return report;
}

export async function inspectDeployment(args = [], options = {}) {
  const ctx = await deploymentContext(options);
  const requestedId = options.deploymentId || options.deployment || args[0] || "";
  const tail = clampTail(Number(options.tail || 200));
  const deployments = await ctx.provider.listComposeDeployments(ctx.composeId);
  const deployment = requestedId
    ? deployments.find((item) => item.id === requestedId) || { id: requestedId, status: "" }
    : deployments[0] || null;
  const deploymentId = deployment?.id || requestedId || "";
  if (!deploymentId) {
    throw new Error("No Dokploy deployments found for this Compose app. Run `nstack deploy` first.");
  }

  const output = await ctx.provider.readDeploymentLogs(deploymentId, { tail });
  const report = {
    app: ctx.config.app.slug,
    target: ctx.config.deploy.target,
    composeId: ctx.composeId,
    deploymentId,
    deployment,
    tail,
    logs: output,
    nextSteps: deploymentNextSteps(deployment),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`deployment: ${deploymentId}`);
  printField("status", deployment.status || null);
  printField("title", deployment.title || null);
  printField("description", deployment.description || null);
  printField("created", deployment.createdAt || null);
  printField("started", deployment.startedAt || null);
  printField("finished", deployment.finishedAt || null);
  console.log("");
  console.log("next steps:");
  if (report.nextSteps.length === 0) console.log("  none");
  else for (const step of report.nextSteps) console.log(`  ${step}`);
  console.log("");
  console.log(`logs (tail ${tail}):`);
  if (output) console.log(output);
  else console.log("  none");
  return report;
}

export async function logs(args = [], options = {}) {
  const ctx = await deploymentContext(options);
  const requestedId = options.deploymentId || options.deployment || args[0] || "";
  const tail = clampTail(Number(options.tail || 100));
  if (options.follow || options.watch) {
    return followLogs(ctx, { requestedId, tail, options });
  }

  const deployments = requestedId ? [] : await ctx.provider.listComposeDeployments(ctx.composeId);
  const deploymentId = requestedId || deployments[0]?.id || "";
  if (!deploymentId) {
    throw new Error("No Dokploy deployments found for this Compose app. Run `nstack deploy` first.");
  }
  const output = await ctx.provider.readDeploymentLogs(deploymentId, { tail });
  const report = {
    app: ctx.config.app.slug,
    target: ctx.config.deploy.target,
    composeId: ctx.composeId,
    deploymentId,
    tail,
    logs: output,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (output) console.log(output);
  return report;
}

async function followLogs(ctx, { requestedId, tail, options }) {
  const timeoutMs = clampWaitMs(Number(options.timeoutMs || options.statusTimeoutMs || 300_000), 300_000);
  const intervalMs = clampWaitMs(Number(options.intervalMs || options.statusIntervalMs || 2000), 2000);
  const startedAt = Date.now();
  let deploymentId = requestedId;
  let deployment = null;
  let logs = "";
  let timedOut = false;
  let polls = 0;

  const initial = await deploymentSnapshot(ctx, deploymentId);
  deployment = initial.deployment;
  deploymentId = deploymentId || deployment?.id || "";
  if (!deploymentId) {
    throw new Error("No Dokploy deployments found for this Compose app. Run `nstack deploy` first.");
  }

  for (;;) {
    polls += 1;
    const nextLogs = await ctx.provider.readDeploymentLogs(deploymentId, { tail });
    const chunk = appendedLogChunk(logs, nextLogs);
    if (chunk && !options.json) writeLogChunk(chunk, options.writeLog);
    logs = nextLogs;

    if (!deployment || !isActiveDeployment(deployment)) break;

    const elapsed = Date.now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      timedOut = true;
      break;
    }

    await sleep(Math.min(intervalMs, remaining));
    const next = await deploymentSnapshot(ctx, deploymentId);
    deployment = next.deployment || deployment;
  }

  const status = deployment?.status || null;
  const report = {
    app: ctx.config.app.slug,
    target: ctx.config.deploy.target,
    composeId: ctx.composeId,
    deploymentId,
    status,
    active: deployment ? isActiveDeployment(deployment) : null,
    finished: deployment ? !isActiveDeployment(deployment) : null,
    follow: true,
    timedOut,
    timeoutMs,
    intervalMs,
    polls,
    tail,
    logs,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (timedOut) {
    console.error(`Stopped following deployment ${deploymentId} after ${timeoutMs}ms; latest status is ${status || "unknown"}.`);
  }
  return report;
}

export async function cancelDeployment(args = [], options = {}) {
  const ctx = await deploymentContext(options);
  const requestedId = options.deploymentId || options.deployment || args[0] || "";
  const deployments = requestedId ? [] : await ctx.provider.listComposeDeployments(ctx.composeId);
  const deployment = requestedId
    ? { id: requestedId, status: "" }
    : deployments.find(isActiveDeployment);
  const deploymentId = deployment?.id || "";
  if (!deploymentId) {
    throw new Error("No active Dokploy deployment found for this Compose app. Pass a deployment ID from `nstack deployments` to cancel a specific attempt.");
  }

  await ctx.provider.killDeployment(deploymentId);
  const report = {
    app: ctx.config.app.slug,
    target: ctx.config.deploy.target,
    composeId: ctx.composeId,
    deploymentId,
    status: deployment.status || null,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`Cancelled deployment ${deploymentId}`);
  return report;
}

async function deploymentContext(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }
  const state = loadState(cwd, config.deploy.target);
  const composeId = state.dokploy?.composeId || "";
  if (!composeId) {
    throw new Error("No Dokploy compose ID saved. Run `nstack pull` or `nstack deploy` first.");
  }
  return {
    config,
    state,
    composeId,
    provider: new DokployProvider({ config, state }),
  };
}

function clampTail(value) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(10_000, Math.trunc(value)));
}

function parseStatusFilter(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function filterDeployments(deployments, { statusFilter }) {
  if (statusFilter.size === 0) return deployments;
  return deployments.filter((deployment) => statusFilter.has(String(deployment.status || "").toLowerCase()));
}

function clampLimit(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function limitDeployments(deployments, limit) {
  return limit ? deployments.slice(0, limit) : deployments;
}

function clampWaitMs(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(86_400_000, Math.trunc(value)));
}

async function deploymentSnapshot(ctx, deploymentId = "") {
  const deployments = await ctx.provider.listComposeDeployments(ctx.composeId);
  const deployment = deploymentId
    ? deployments.find((item) => item.id === deploymentId) || null
    : deployments[0] || null;
  return { deployments, deployment };
}

function appendedLogChunk(previous, next) {
  if (!next) return "";
  if (!previous) return next;
  if (next === previous) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);

  const maxOverlap = Math.min(previous.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) return next.slice(size);
  }
  return next;
}

function writeLogChunk(chunk, write = process.stdout.write.bind(process.stdout)) {
  write(chunk);
  if (!chunk.endsWith("\n")) write("\n");
}

function printField(name, value) {
  console.log(`  ${name}: ${value === null || value === undefined || value === "" ? "(missing)" : value}`);
}

function deploymentNextSteps(deployment = {}) {
  const id = deployment.id || "";
  if (!id) return [];
  if (isActiveDeployment(deployment)) {
    return [
      `Run \`nstack logs ${id} --follow\` to stream the active deployment.`,
      `Run \`nstack cancel ${id}\` to stop it.`,
      "Run `nstack wait` after it finishes to verify and promote the release.",
    ];
  }
  if (isFailedDeployment(deployment)) {
    return [
      `Run \`nstack logs ${id}\` to review the final log tail.`,
      "Run `nstack redeploy` to retry the current saved release.",
      "Run `nstack rollback` to return to the previous verified release.",
    ];
  }
  if (isCompletedDeployment(deployment)) {
    return ["Run `nstack status --check --json` to confirm domains, schedules, images, and env are converged."];
  }
  return [`Run \`nstack logs ${id}\` for the deployment log tail.`];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActiveDeployment(deployment) {
  const status = String(deployment.status || "").toLowerCase();
  return /running|queued?|building|deploying|pending|progress|processing|created|started/.test(status);
}

function isFailedDeployment(deployment) {
  const status = String(deployment.status || "").toLowerCase();
  return /fail|error|cancel|killed|dead|terminated/.test(status);
}

function isCompletedDeployment(deployment) {
  const status = String(deployment.status || "").toLowerCase();
  return /done|success|complete|completed|ready|deployed/.test(status);
}
