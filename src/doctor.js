import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  generatedDir,
  loadConfig,
  loadState,
  localEnvPathForTarget,
  secretsEnvPathForTarget,
  targetFromOptions,
} from "./config.js";
import { discoverEncoreResources } from "./encore.js";
import { platformCheck } from "./platform.js";
import { DokployProvider } from "./providers/dokploy.js";
import { fileExists, parseDotEnv, readText } from "./util.js";

export async function doctor(options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = await createDoctorReport({
    cwd,
    target: targetFromOptions(options),
    checkRemote: !options.skipRemote,
  });
  const ok = options.skipBuild ? report.ready.deploySkipBuild : report.ready.deploy;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (options.check && !ok) process.exitCode = 1;
    return report;
  }

  printReport(report);
  if (options.check && !ok) process.exitCode = 1;
  return report;
}

export async function createDoctorReport({
  cwd = process.cwd(),
  target = "",
  config = null,
  state = null,
  resources = null,
  checkRemote = false,
} = {}) {
  const resolvedConfig = config || await loadConfig(cwd, { target });
  const resolvedState = state || loadState(cwd, resolvedConfig.deploy.target);
  const resourcesPromise = resources ? Promise.resolve(resources) : inspectResources(cwd, resolvedConfig);
  const remotePromise = inspectRemote(resolvedConfig, resolvedState, { checkRemote });
  const [resolvedResources, remote] = await Promise.all([resourcesPromise, remotePromise]);
  return buildReport({
    cwd,
    config: resolvedConfig,
    state: resolvedState,
    resources: resolvedResources,
    remote,
  });
}

function buildReport({ cwd, config, state, resources, remote }) {
  const localEnvPath = localEnvPathForTarget(config.deploy.target);
  const secretsEnvPath = secretsEnvPathForTarget(config.deploy.target);
  const localEnv = parseDotEnv(readText(path.join(cwd, localEnvPath), ""));
  const secretsEnv = parseDotEnv(readText(path.join(cwd, secretsEnvPath), ""));
  const configuredSecrets = new Set([
    ...Object.keys(secretsEnv),
    ...resources.secrets.filter((name) => Boolean(process.env[name])),
  ]);
  const exposedCronEndpoints = exposedCrons(resources);
  const report = {
    app: {
      name: config.app.name,
      slug: config.app.slug,
      domain: config.app.domain || null,
    },
    deploy: {
      target: config.deploy.target,
      buildMode: config.deploy.buildMode,
      registry: config.deploy.registry || null,
      source: {
        repository: config.deploy.source?.repository || null,
        branch: config.deploy.source?.branch || null,
      },
      platform: config.deploy.platform || null,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
      dokployUrl: config.deploy.provider.url || null,
      dokployApiKeySet: Boolean(config.deploy.provider.apiKey),
      serverId: config.deploy.provider.serverId || null,
    },
    remote,
    files: {
      config: fileExists(path.join(cwd, "nstack.config.mjs")),
      localEnv: fileExists(path.join(cwd, localEnvPath)),
      secretsEnv: fileExists(path.join(cwd, secretsEnvPath)),
      backend: fileExists(path.join(cwd, config.paths.backend)),
      backendDockerfile: fileExists(path.join(cwd, config.paths.backendDockerfile)),
      frontend: fileExists(path.join(cwd, config.paths.frontend)),
      frontendDockerfile: fileExists(path.join(cwd, config.paths.frontendDockerfile)),
      generatedCompose: fileExists(path.join(cwd, generatedDir, "compose.dokploy.yaml")),
      generatedInfra: fileExists(path.join(cwd, generatedDir, "encore.infra.json")),
    },
    localEnv: {
      keys: Object.keys(localEnv).sort(),
    },
    secrets: {
      keys: Object.keys(secretsEnv).sort(),
      required: resources.secrets,
      missing: resources.secrets.filter((name) => !configuredSecrets.has(name)),
    },
    resources: {
      source: resources.source,
      metadataError: resources.metadataError || null,
      services: resources.services.length,
      databases: resources.databases.map((database) => database.name).sort(),
      caches: resources.caches.map((cache) => cache.name).sort(),
      topics: resources.topics.map((topic) => topic.name).sort(),
      crons: resources.crons.map((cron) => cron.name).sort(),
      exposedCrons: exposedCronEndpoints,
      buckets: resources.buckets.map((bucket) => bucket.name).sort(),
    },
    tools: {
      node: { ok: nodeMajor() >= 22, version: process.version },
      encore: toolVersion("encore", ["version"]),
      backendBuild: toolVersion("tsbundler-encore", ["-h"]),
      docker: toolVersion("docker", ["--version"]),
    },
    state: {
      projectId: state.dokploy?.projectId || null,
      environmentId: state.dokploy?.environmentId || null,
      postgresId: state.dokploy?.postgresId || null,
      redisId: state.dokploy?.redisId || null,
      composeId: state.dokploy?.composeId || null,
      scheduleCount: Object.keys(state.dokploy?.schedules || {}).length,
      lastRelease: state.lastRelease || null,
    },
  };
  report.checks = buildChecks(report);
  const readiness = { buildMode: report.deploy.buildMode };
  report.ready = {
    render: checksOk(report.checks, checkNamesFor("render", readiness)),
    build: checksOk(report.checks, checkNamesFor("build", readiness)),
    deploy: checksOk(report.checks, checkNamesFor("deploy", readiness)),
    deploySkipBuild: checksOk(report.checks, checkNamesFor("deploy", { ...readiness, skipBuild: true })),
  };
  report.nextSteps = preflightFailures(report, "deploy", readiness);
  return report;
}

export async function inspectResources(cwd, config) {
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

async function inspectRemote(config, state, { checkRemote = false } = {}) {
  const canCheck = Boolean(
    checkRemote &&
    config.deploy.provider.type === "dokploy" &&
    config.deploy.provider.url &&
    config.deploy.provider.apiKey,
  );
  if (!canCheck) {
    return {
      dokploy: {
        checked: false,
        ok: null,
        error: null,
      },
    };
  }

  try {
    const provider = new DokployProvider({ config, state });
    await provider.checkConnection();
    return {
      dokploy: {
        checked: true,
        ok: true,
        error: null,
      },
    };
  } catch (error) {
    return {
      dokploy: {
        checked: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function printReport(report) {
  console.log(`app: ${report.app.slug}`);
  line("domain", report.app.domain);
  line("target", report.deploy.target);
  line("build mode", report.deploy.buildMode);
  if (report.deploy.buildMode === "registry") line("registry", report.deploy.registry);
  if (report.deploy.buildMode === "compose") {
    line("source repository", report.deploy.source.repository);
    line("source branch", report.deploy.source.branch);
  }
  line("platform", report.deploy.platform);
  line("provider", report.deploy.provider);
  line("project", report.deploy.project);
  line("environment", report.deploy.environment);
  line("dokploy url", report.deploy.dokployUrl);
  line("dokploy api key", report.deploy.dokployApiKeySet ? "(set)" : null);
  console.log("");
  console.log("files:");
  for (const [name, ok] of Object.entries(report.files)) line(name, ok ? "ok" : null, "  ");
  console.log("");
  console.log("tools:");
  line("node", report.tools.node.ok ? report.tools.node.version : null, "  ");
  line("encore", report.tools.encore.ok ? report.tools.encore.version : null, "  ");
  line("backend build", report.tools.backendBuild.ok ? report.tools.backendBuild.version : null, "  ");
  line("docker", report.tools.docker.ok ? report.tools.docker.version : null, "  ");
  console.log("");
  console.log("remote:");
  if (report.remote.dokploy.checked) {
    line("dokploy api", report.remote.dokploy.ok ? "ok" : report.remote.dokploy.error, "  ");
  } else {
    line("dokploy api", "not checked", "  ");
  }
  console.log("");
  console.log("secrets:");
  if (report.secrets.keys.length === 0) console.log("  none");
  else for (const key of report.secrets.keys) console.log(`  ${key}=********`);
  if (report.secrets.missing.length > 0) {
    console.log("  missing:");
    for (const key of report.secrets.missing) console.log(`    ${key}`);
  }
  console.log("");
  console.log("resources:");
  line("source", report.resources.source, "  ");
  line("services", report.resources.services, "  ");
  line("databases", report.resources.databases.length ? report.resources.databases.join(", ") : null, "  ");
  line("caches", report.resources.caches.length ? report.resources.caches.join(", ") : null, "  ");
  line("topics", report.resources.topics.length ? report.resources.topics.join(", ") : null, "  ");
  line("crons", report.resources.crons.length ? report.resources.crons.join(", ") : null, "  ");
  line("public cron endpoints", report.resources.exposedCrons.length ? report.resources.exposedCrons.join(", ") : null, "  ");
  line("buckets", report.resources.buckets.length ? report.resources.buckets.join(", ") : null, "  ");
  if (report.resources.metadataError) line("metadata error", report.resources.metadataError, "  ");
  console.log("");
  console.log("ready:");
  line("render", report.ready.render ? "yes" : "no", "  ");
  line("build", report.ready.build ? "yes" : "no", "  ");
  line("deploy", report.ready.deploy ? "yes" : "no", "  ");
  line("deploy --skip-build", report.ready.deploySkipBuild ? "yes" : "no", "  ");
  console.log("");
  console.log("next steps:");
  if (report.nextSteps.length === 0) console.log("  none");
  else for (const step of report.nextSteps) console.log(`  ${step}`);
  console.log("");
  console.log("state:");
  for (const [name, value] of Object.entries(report.state)) line(name, value, "  ");
}

function line(name, value, prefix = "") {
  console.log(`${prefix}${name}: ${value === null || value === undefined || value === "" ? "(missing)" : value}`);
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return { ok: false, version: "" };
  return {
    ok: true,
    version: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0],
  };
}

function buildChecks(report) {
  const platform = platformCheck(report.deploy.platform);
  return [
    check("config", report.files.config, "Run `nstack init` to create nstack.config.mjs."),
    check("domain", Boolean(report.app.domain), "Run `nstack configure --domain <domain>`."),
    check("registry", report.deploy.buildMode !== "registry" || Boolean(report.deploy.registry), "Run `nstack configure --build-mode registry --registry <image-prefix>`."),
    check("source-repository", report.deploy.buildMode !== "compose" || Boolean(report.deploy.source.repository), "Run `nstack configure --repository <git-url>` or set NSTACK_REPOSITORY."),
    check("platform", platform.ok, platform.error),
    check("dokploy-url", Boolean(report.deploy.dokployUrl), "Run `nstack configure --dokploy-url <url>`."),
    check("dokploy-api-key", report.deploy.dokployApiKeySet, "Run `nstack configure --dokploy-api-key <key>`."),
    check("dokploy-connection", dokployConnectionOk(report), dokployConnectionFix(report)),
    check("backend", report.files.backend, "Create the configured backend directory or update paths.backend."),
    check("backend-dockerfile", report.files.backendDockerfile, "Create the backend Dockerfile or update paths.backendDockerfile."),
    check("frontend", report.files.frontend, "Create the configured frontend directory or update paths.frontend."),
    check("frontend-dockerfile", report.files.frontendDockerfile, "Create the frontend Dockerfile or update paths.frontendDockerfile."),
    check("node", report.tools.node.ok, "Install Node.js 22 or newer."),
    check("encore", report.tools.encore.ok, "Install the Encore CLI. Encore Cloud login is not required."),
    check("backend-build", report.tools.backendBuild.ok, "Install or update Encore so tsbundler-encore is available on PATH. Encore Cloud login is not required."),
    check("docker", report.tools.docker.ok, "Install Docker and make sure it is available on PATH."),
    check("app-secrets", report.secrets.missing.length === 0, `Set missing app runtime secrets: ${report.secrets.missing.join(", ")}`),
    check("resource-discovery", report.resources.source !== "error", "Fix Encore resource discovery before deploying."),
    check("cron-endpoints-private", report.resources.exposedCrons.length === 0, `Make Encore cron endpoints private with api({ expose: false }, ...): ${report.resources.exposedCrons.join(", ")}`),
  ];
}

export function preflightFailures(report, mode, options = {}) {
  const buildMode = options.buildMode || report.deploy?.buildMode;
  const ignored = new Set(options.ignore || []);
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  return checkNamesFor(mode, { ...options, buildMode })
    .filter((name) => !ignored.has(name))
    .map((name) => byName.get(name))
    .filter((check) => check && !check.ok)
    .map((check) => check.fix);
}

export function preflightError(command, failures) {
  if (failures.length === 0) return null;
  return new Error([
    `nstack ${command} preflight failed:`,
    ...failures.map((failure) => `  - ${failure}`),
    "Run `nstack doctor` for the full report.",
  ].join("\n"));
}

function checkNamesFor(mode, options = {}) {
  const buildMode = options.buildMode || "registry";
  if (mode === "render") return ["config", "domain", "backend", "resource-discovery", "cron-endpoints-private"];
  if (mode === "build") {
    const names = [
      "config",
      "domain",
      "platform",
      "backend",
      "frontend",
      "frontend-dockerfile",
      "node",
      "docker",
      "resource-discovery",
      "cron-endpoints-private",
    ];
    if (buildMode === "registry") names.splice(2, 0, "registry");
    if (buildMode === "registry") names.push("encore", "backend-build");
    if (buildMode === "compose") names.splice(5, 0, "backend-dockerfile");
    return names;
  }
  const names = [
    "config",
    "domain",
    "dokploy-url",
    "dokploy-api-key",
    "dokploy-connection",
    "backend",
    "node",
    "app-secrets",
    "resource-discovery",
    "cron-endpoints-private",
  ];
  if (buildMode === "registry") names.splice(2, 0, "registry");
  if (buildMode === "compose") names.splice(2, 0, "source-repository", "frontend", "backend-dockerfile", "frontend-dockerfile");
  if (!options.skipBuild) {
    if (buildMode === "registry") names.push("platform", "frontend", "frontend-dockerfile", "encore", "backend-build", "docker");
  }
  return names;
}

function dokployConnectionOk(report) {
  return !report.remote?.dokploy?.checked || report.remote.dokploy.ok;
}

function dokployConnectionFix(report) {
  const error = report.remote?.dokploy?.error;
  if (error) return `Fix Dokploy API access: ${error}`;
  return "Check DOKPLOY_URL, DOKPLOY_API_KEY, and Dokploy API access.";
}

function check(name, ok, fix) {
  return Boolean(ok) ? { name, ok: true } : { name, ok: false, fix };
}

function checksOk(checks, names) {
  const byName = new Map(checks.map((check) => [check.name, check.ok]));
  return names.every((name) => byName.get(name));
}

function exposedCrons(resources) {
  return (resources.crons || [])
    .filter((cron) => cron.endpoint?.exposed === true)
    .map((cron) => {
      const endpoint = cron.endpoint || {};
      return `${cron.name} (${endpoint.service || "unknown"}.${endpoint.name || "unknown"})`;
    })
    .sort();
}
