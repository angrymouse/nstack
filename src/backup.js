import { createHash, createHmac } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadState, targetFromOptions } from "./config.js";
import { inspectResources } from "./doctor.js";
import { Prompter } from "./prompt.js";
import { DokployProvider } from "./providers/dokploy.js";
import { createProgress } from "./progress.js";
import { ensureDir, formatDotEnv, writeJSON, writeText } from "./util.js";

const backupDestinationEnv = "NSTACK_BACKUP_DESTINATION_ID";
const noDeletionBackupsEnv = "NSTACK_NO_BACKUPS_ON_DELETION";

export async function backup(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  assertDokployConfigured(config);

  const state = loadState(cwd, config.deploy.target);
  const stamp = backupStamp();
  const progress = createProgress({ enabled: !options.json });
  const resources = await progress.step("Inspecting Encore resources", () => inspectResources(cwd, config));
  const provider = new DokployProvider({ config, state });
  const pulled = await progress.step("Reading Dokploy state", () =>
    provider.pullExistingState(resourcesForDokployDiscovery(resources, state)));
  const remote = await progress.step("Reading Dokploy resources", () => readRemoteSnapshot(provider, pulled.dokploy));
  const backupDir = resolveBackupDir(cwd, config, options, stamp);
  const snapshot = await progress.step("Writing backup snapshot", () => writeSnapshot({
    backupDir,
    config,
    resources,
    pulled,
    remote,
  }));
  const data = await backupData({ progress, backupDir, config, state, resources, pulled, remote, provider, options, stamp });
  const manifest = await progress.step("Writing backup manifest", () => writeManifest({
    backupDir,
    config,
    resources,
    pulled,
    remote,
    snapshot,
    data,
    options,
    stamp,
  }));

  const report = {
    app: config.app.slug,
    target: config.deploy.target,
    backupDir,
    sizeBytes: totalDataBytes(data),
    size: formatBytes(totalDataBytes(data)),
    files: manifest.files,
    data,
    remote: {
      projectId: pulled.dokploy?.projectId || null,
      environmentId: pulled.dokploy?.environmentId || null,
      composeId: pulled.dokploy?.composeId || null,
      postgresId: pulled.dokploy?.postgresId || null,
      redisId: pulled.dokploy?.redisId || null,
    },
  };

  if (options.critical) assertCriticalBackup(report);
  if (options.json && !options.silent) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  if (!options.json && !options.silent) printBackupReport(report);
  return report;
}

export async function backupBeforeDeletion(options = {}) {
  if (process.env[noDeletionBackupsEnv]) {
    return {
      skipped: true,
      reason: `${noDeletionBackupsEnv} is set.`,
      sizeBytes: 0,
      size: "0 B",
    };
  }
  return backup({ ...options, critical: true, deletionBackup: true, json: true, silent: true });
}

export function deletionBackupDisabled() {
  return Boolean(process.env[noDeletionBackupsEnv]);
}

export function deletionBackupEnvName() {
  return noDeletionBackupsEnv;
}

export function formatBytes(bytes = 0) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function assertDokployConfigured(config) {
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }
}

async function readRemoteSnapshot(provider, dokploy = {}) {
  return {
    project: await captureRemote(() => provider.findProjectRecord(dokploy.projectId)),
    environment: await captureRemote(() => provider.client.apiGet("environment.one", { environmentId: dokploy.environmentId })),
    compose: await captureRemote(() => provider.client.apiGet("compose.one", { composeId: dokploy.composeId })),
    domains: await captureRemote(() => provider.client.apiGet("domain.byComposeId", { composeId: dokploy.composeId })),
    schedules: await captureRemote(() => provider.client.apiGet("schedule.list", {
      id: dokploy.composeId,
      scheduleType: "compose",
    })),
    postgres: dokploy.postgresId
      ? await captureRemote(() => provider.client.apiGet("postgres.one", { postgresId: dokploy.postgresId }))
      : skippedRemote("No Dokploy Postgres resource was resolved."),
    redis: dokploy.redisId
      ? await captureRemote(() => provider.client.apiGet("redis.one", { redisId: dokploy.redisId }))
      : skippedRemote("No Dokploy Redis resource was resolved."),
  };
}

async function captureRemote(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function skippedRemote(reason) {
  return { ok: false, skipped: true, reason };
}

function writeSnapshot({ backupDir, config, resources, pulled, remote }) {
  ensureDir(backupDir);
  const files = {};
  const remoteFile = path.join(backupDir, "dokploy.resources.json");
  writeJSON(remoteFile, {
    dokploy: pulled.dokploy,
    composeSummary: pulled.compose,
    remote,
  });
  files.dokployResources = remoteFile;

  const composeFile = remote.compose?.value?.composeFile || "";
  if (composeFile) {
    const file = path.join(backupDir, "compose.dokploy.yaml");
    writeText(file, composeFile.endsWith("\n") ? composeFile : `${composeFile}\n`);
    files.compose = file;
  }

  const envText = remote.compose?.value?.env || remote.compose?.value?.environment || formatDotEnv(pulled.env || {});
  if (envText) {
    const file = path.join(backupDir, "compose.env");
    writeText(file, envText.endsWith("\n") ? envText : `${envText}\n`);
    files.composeEnv = file;
  }

  const resourcesFile = path.join(backupDir, "encore.resources.json");
  writeJSON(resourcesFile, resourcesSummary(resources));
  files.encoreResources = resourcesFile;

  const targetFile = path.join(backupDir, "nstack.target.json");
  writeJSON(targetFile, {
    app: {
      name: config.app.name,
      slug: config.app.slug,
      domain: config.app.domain || null,
    },
    deploy: {
      target: config.deploy.target,
      buildMode: config.deploy.buildMode,
      provider: {
        type: config.deploy.provider.type,
        url: config.deploy.provider.url,
        apiKey: config.deploy.provider.apiKey,
        projectName: config.deploy.provider.projectName,
        environmentName: config.deploy.provider.environmentName,
        serverId: config.deploy.provider.serverId || null,
      },
      source: {
        repository: config.deploy.source?.repository || null,
        branch: config.deploy.source?.branch || null,
        sourceType: config.deploy.source?.sourceType || null,
      },
    },
  });
  files.nstackTarget = targetFile;
  return { files };
}

async function backupData({ progress, backupDir, config, state, resources, pulled, remote, provider, options, stamp }) {
  const items = statefulBackupItems({ config, state, resources, pulled, remote, stamp });
  const data = initialDataStatus(items);
  if (items.length === 0 || options.metadataOnly) return data;

  const destination = await progress.step("Resolving Dokploy backup destination", () =>
    resolveBackupDestination(provider, options));
  for (const item of items) {
    data[item.key] = await progress.step(item.label, () =>
      runDokployBackupItem({ provider, destination, item, backupDir, options }));
  }
  return data;
}

function initialDataStatus(items) {
  const data = {
    postgres: { status: "skipped", reason: "No Postgres resource found." },
    redis: { status: "skipped", reason: "No Redis resource found." },
    objectStorage: { status: "skipped", reason: "No object storage buckets found." },
    pubsub: { status: "skipped", reason: "No Pub/Sub topics found." },
  };
  for (const item of items) data[item.key] = { status: "pending" };
  return data;
}

function statefulBackupItems({ config, state, resources, pulled, remote, stamp }) {
  const prefixBase = `nstack/${config.app.slug}/${config.deploy.target}/${stamp}`;
  const items = [];
  const postgres = remote.postgres?.ok ? remote.postgres.value : null;
  const redis = remote.redis?.ok ? remote.redis.value : null;
  const compose = remote.compose?.ok ? remote.compose.value : null;
  if (postgresWanted(resources, state, pulled)) {
    const settings = postgresSettings(config, state, pulled.env || {}, postgres);
    items.push({
      key: "postgres",
      type: "database",
      label: "Creating Postgres backup",
      localName: "postgres.sql.gz",
      destinationAppName: settings.appName,
      prefix: `${prefixBase}/postgres`,
      createPayload: {
        schedule: "0 0 1 1 *",
        enabled: false,
        prefix: `${prefixBase}/postgres`,
        destinationId: "",
        database: settings.database,
        postgresId: pulled.dokploy?.postgresId || state.dokploy?.postgresId || "",
        databaseType: "postgres",
        backupType: "database",
      },
      findBackup: (backup) => backup?.backupType === "database" && backup?.databaseType === "postgres" && backup?.database === settings.database,
      manualEndpoint: "backup.manualBackupPostgres",
      idField: "backupId",
    });
  }
  if (redisWanted(resources, state, pulled)) {
    const settings = redisSettings(config, state, pulled.env || {}, redis);
    items.push(volumeItem({
      key: "redis",
      label: "Creating Redis backup",
      localName: "redis-volume.tar",
      prefix: `${prefixBase}/redis`,
      destinationAppName: settings.appName,
      volumeName: redisVolumeName(redis, settings.appName),
      volumeBackupType: "redis",
      id: pulled.dokploy?.redisId || state.dokploy?.redisId || "",
      serviceType: "redis",
    }));
  }
  if (objectStorageWanted(resources, state, compose)) {
    const composeAppName = compose?.appName || compose?.name || config.app.slug;
    items.push(volumeItem({
      key: "objectStorage",
      label: "Creating object storage backup",
      localName: "object-storage-volume.tar",
      prefix: `${prefixBase}/object-storage`,
      destinationAppName: `${composeAppName}_rustfs`,
      volumeName: `rustfs_data-${composeAppName}`,
      volumeBackupType: "compose",
      id: pulled.dokploy?.composeId || state.dokploy?.composeId || "",
      serviceType: "compose",
      serviceName: "rustfs",
      turnOff: true,
    }));
  }
  if (pubsubWanted(resources, compose)) {
    const composeAppName = compose?.appName || compose?.name || config.app.slug;
    items.push(volumeItem({
      key: "pubsub",
      label: "Creating Pub/Sub backup",
      localName: "pubsub-nsq-volume.tar",
      prefix: `${prefixBase}/pubsub`,
      destinationAppName: `${composeAppName}_nsqd`,
      volumeName: `nsq_data-${composeAppName}`,
      volumeBackupType: "compose",
      id: pulled.dokploy?.composeId || state.dokploy?.composeId || "",
      serviceType: "compose",
      serviceName: "nsqd",
      turnOff: true,
    }));
  }
  return items;
}

function volumeItem({ key, label, localName, prefix, destinationAppName, volumeName, volumeBackupType, id, serviceType, serviceName = "", turnOff = false }) {
  return {
    key,
    type: "volume",
    label,
    localName,
    prefix,
    destinationAppName,
    volumeBackupType,
    id,
    createPayload: {
      name: `nstack ${key}`,
      volumeName,
      prefix,
      serviceName,
      serviceType,
      turnOff,
      cronExpression: "0 0 1 1 *",
      enabled: false,
      destinationId: "",
      ...(volumeBackupType === "redis" ? { redisId: id } : {}),
      ...(volumeBackupType === "compose" ? { composeId: id } : {}),
    },
    findBackup: (backup) => backup?.volumeName === volumeName && backup?.serviceName === serviceName,
    idField: "volumeBackupId",
  };
}

async function resolveBackupDestination(provider, options) {
  const requested = options.backupDestinationId || process.env[backupDestinationEnv] || "";
  if (requested) return provider.client.apiGet("destination.one", { destinationId: requested });
  const destinations = asList(await provider.client.apiGet("destination.all"));
  if (destinations.length === 0) {
    throw missingBackupDestinationError();
  }
  if (destinations.length === 1 || options.yes || process.stdin.isTTY !== true) {
    return provider.client.apiGet("destination.one", { destinationId: destinations[0].destinationId || destinations[0].id });
  }
  const prompter = new Prompter({ yes: false });
  try {
    const choice = await prompter.select("NSTACK_BACKUP_DESTINATION_ID", "Backup destination", destinations.map((destination) => ({
      value: destination.destinationId || destination.id,
      label: destination.name || destination.destinationId || destination.id,
      hint: destination.provider || destination.bucket || "",
    })));
    return provider.client.apiGet("destination.one", { destinationId: choice.value });
  } finally {
    prompter.close();
  }
}

function missingBackupDestinationError() {
  return new Error([
    "No Dokploy backup destination is configured.",
    "Create an operator-managed Dokploy backup destination first, then pass --backup-destination-id <id> or set NSTACK_BACKUP_DESTINATION_ID.",
  ].join("\n"));
}

async function runDokployBackupItem({ provider, destination, item, backupDir, options }) {
  const resourceId = item.id || item.createPayload?.postgresId || "";
  if (!resourceId) {
    throw new Error(`Cannot back up ${item.key}: matching Dokploy resource id was not resolved.`);
  }
  const before = await listDestinationFiles(provider, destination, item);
  const backupRecord = item.type === "database"
    ? await ensureDatabaseBackup(provider, item, destination)
    : await ensureVolumeBackup(provider, item, destination);
  const id = backupRecord[item.idField];
  if (!id) throw new Error(`Dokploy did not return a backup id for ${item.key}.`);
  const ran = item.type === "database"
    ? await provider.client.apiPost(item.manualEndpoint, { backupId: id })
    : await provider.client.apiPost("volumeBackups.runManually", { volumeBackupId: id });
  if (ran === false) throw new Error(`Dokploy failed to run ${item.key} backup.`);

  const file = await waitForNewDestinationFile(provider, destination, item, before, options);
  const localFile = path.join(backupDir, item.localName);
  await downloadDestinationFile(destination, file.Path, localFile);
  const bytes = statSync(localFile).size;
  return {
    status: "ok",
    file: localFile,
    remotePath: file.Path,
    destinationId: destination.destinationId || destination.id,
    bytes,
    size: formatBytes(bytes),
    format: path.extname(localFile).replace(/^\./, "") || "data",
  };
}

async function ensureDatabaseBackup(provider, item, destination) {
  const current = await provider.client.apiGet("postgres.one", { postgresId: item.createPayload.postgresId });
  const existing = findMatchingBackup(asList(current.backups), item, destination);
  if (existing) return existing;
  await provider.client.apiPost("backup.create", {
    ...item.createPayload,
    destinationId: destination.destinationId || destination.id,
  });
  const refreshed = await provider.client.apiGet("postgres.one", { postgresId: item.createPayload.postgresId });
  const created = findMatchingBackup(asList(refreshed.backups), item, destination);
  if (!created) throw new Error(`Could not create or find Dokploy Postgres backup config for ${item.key}.`);
  return created;
}

async function ensureVolumeBackup(provider, item, destination) {
  const existing = findMatchingBackup(asList(await provider.client.apiGet("volumeBackups.list", {
    id: item.id,
    volumeBackupType: item.volumeBackupType,
  })), item, destination);
  if (existing) return existing;
  const created = await provider.client.apiPost("volumeBackups.create", {
    ...item.createPayload,
    destinationId: destination.destinationId || destination.id,
  });
  if (created?.volumeBackupId) return created;
  const refreshed = asList(await provider.client.apiGet("volumeBackups.list", {
    id: item.id,
    volumeBackupType: item.volumeBackupType,
  }));
  const backup = findMatchingBackup(refreshed, item, destination);
  if (!backup) throw new Error(`Could not create or find Dokploy volume backup config for ${item.key}.`);
  return backup;
}

function findMatchingBackup(backups, item, destination) {
  const destinationId = destination.destinationId || destination.id;
  return backups.find((backup) =>
    backup?.destinationId === destinationId &&
    backup.prefix === item.prefix &&
    item.findBackup(backup));
}

async function listDestinationFiles(provider, destination, item) {
  return asList(await provider.client.apiGet("backup.listBackupFiles", {
    destinationId: destination.destinationId || destination.id,
    search: `${item.destinationAppName}/${trimSlashes(item.prefix)}`,
    ...(destination.serverId ? { serverId: destination.serverId } : {}),
  }));
}

async function waitForNewDestinationFile(provider, destination, item, before, options) {
  const beforePaths = new Set(before.map((file) => file.Path));
  const timeoutMs = Number(options.backupTimeoutMs || 120000);
  const intervalMs = Number(options.backupIntervalMs || 2000);
  const started = Date.now();
  for (;;) {
    const files = await listDestinationFiles(provider, destination, item);
    const candidates = files
      .filter((file) => !file.IsDir && file.Path && !beforePaths.has(file.Path))
      .sort((a, b) => String(b.Path).localeCompare(String(a.Path)));
    if (candidates[0]) return candidates[0];
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for Dokploy to publish ${item.key} backup file.`);
    }
    await sleep(intervalMs);
  }
}

async function downloadDestinationFile(destination, key, file) {
  const response = await signedS3Fetch(destination, key);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Downloading backup ${key} failed: ${response.status} ${detail}`.trim());
  }
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function signedS3Fetch(destination, key) {
  const endpoint = endpointUrl(destination.endpoint);
  const bucket = destination.bucket;
  const region = destination.region || "us-east-1";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, "")}/${encodePathSegment(bucket)}/${key.split("/").map(encodePathSegment).join("/")}`;
  const url = new URL(endpoint.href);
  url.pathname = canonicalUri;
  const payloadHash = sha256("");
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = ["GET", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${destination.secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return fetch(url, {
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${destination.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

function endpointUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Dokploy backup destination endpoint is empty.");
  return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function writeManifest({ backupDir, config, resources, pulled, remote, snapshot, data, options, stamp }) {
  const manifestFile = path.join(backupDir, "manifest.json");
  const manifest = {
    version: 1,
    createdAt: stampToIso(stamp),
    timestamp: stamp,
    app: {
      name: config.app.name,
      slug: config.app.slug,
      domain: config.app.domain || null,
    },
    target: config.deploy.target,
    dokploy: {
      url: config.deploy.provider.url,
      projectName: config.deploy.provider.projectName,
      environmentName: config.deploy.provider.environmentName,
      projectId: pulled.dokploy?.projectId || null,
      environmentId: pulled.dokploy?.environmentId || null,
      composeId: pulled.dokploy?.composeId || null,
      postgresId: pulled.dokploy?.postgresId || null,
      redisId: pulled.dokploy?.redisId || null,
      apiKeyIncluded: false,
    },
    resources: resourcesSummary(resources),
    files: relativeFiles(backupDir, { ...snapshot.files, ...dataFiles(data) }),
    data: manifestData(data),
    sizeBytes: totalDataBytes(data),
    size: formatBytes(totalDataBytes(data)),
    remoteErrors: remoteErrors(remote),
    options: {
      metadataOnly: Boolean(options.metadataOnly),
      deletionBackup: Boolean(options.deletionBackup),
    },
    notes: [
      "Backup snapshot files preserve secrets for recovery. Keep .nstack/backups private.",
      "Data artifacts are downloaded from the configured Dokploy backup destination.",
    ],
  };
  writeJSON(manifestFile, manifest);
  return {
    files: {
      ...relativeFiles(backupDir, { ...snapshot.files, manifest: manifestFile }),
      ...relativeFiles(backupDir, dataFiles(data)),
    },
  };
}

function dataFiles(data) {
  return Object.fromEntries(Object.entries(data)
    .filter(([, value]) => value?.file)
    .map(([key, value]) => [`${key}Data`, value.file]));
}

function manifestData(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    {
      status: value.status,
      reason: value.reason || null,
      file: value.file ? path.basename(value.file) : null,
      remotePath: value.remotePath || null,
      format: value.format || null,
      bytes: typeof value.bytes === "number" ? value.bytes : null,
      size: value.size || null,
    },
  ]));
}

function assertCriticalBackup(report) {
  const failures = Object.entries(report.data)
    .filter(([, value]) => value.status === "pending" || (value.status !== "ok" && !/^No /.test(value.reason || "")));
  if (failures.length > 0) {
    throw new Error([
      "Required local backup was not completed; refusing destructive deletion.",
      ...failures.map(([key, value]) => `  - ${key}: ${value.reason || value.status}`),
      `Set ${noDeletionBackupsEnv}=1 to explicitly delete without local backups.`,
    ].join("\n"));
  }
}

function totalDataBytes(data) {
  return Object.values(data).reduce((sum, value) => sum + (Number(value.bytes) || 0), 0);
}

function remoteErrors(remote) {
  return Object.fromEntries(Object.entries(remote)
    .filter(([, result]) => result && !result.ok && !result.skipped)
    .map(([key, result]) => [key, result.error || "Unknown error"]));
}

function relativeFiles(base, files) {
  return Object.fromEntries(Object.entries(files)
    .filter(([, file]) => Boolean(file))
    .map(([key, file]) => [key, path.relative(base, file)]));
}

function resourcesSummary(resources) {
  return {
    source: resources.source,
    metadataError: resources.metadataError || null,
    services: (resources.services || []).map((service) => service.name).filter(Boolean).sort(),
    databases: (resources.databases || []).map((database) => database.name).filter(Boolean).sort(),
    caches: (resources.caches || []).map((cache) => cache.name).filter(Boolean).sort(),
    topics: (resources.topics || []).map((topic) => topic.name).filter(Boolean).sort(),
    buckets: (resources.buckets || []).map((bucket) => bucket.name).filter(Boolean).sort(),
    crons: (resources.crons || []).map((cron) => cron.name).filter(Boolean).sort(),
    secrets: [...(resources.secrets || [])].sort(),
  };
}

function resourcesForDokployDiscovery(resources, state) {
  return {
    ...resources,
    databases: ensureResourceList(resources.databases, state.dokploy?.postgresId || state.infra?.postgres),
    caches: ensureResourceList(resources.caches, state.dokploy?.redisId || state.infra?.redis),
    buckets: ensureResourceList(resources.buckets, state.infra?.objectStorage),
    crons: resources.crons || [],
  };
}

function ensureResourceList(list = [], fallback) {
  if (list.length > 0 || !fallback) return list || [];
  return [{ name: "unknown" }];
}

function postgresWanted(resources, state, pulled) {
  return (resources.databases || []).length > 0 || Boolean(state.infra?.postgres || pulled.dokploy?.postgresId);
}

function redisWanted(resources, state, pulled) {
  return (resources.caches || []).length > 0 || Boolean(state.infra?.redis || pulled.dokploy?.redisId);
}

function objectStorageWanted(resources, state, compose) {
  return (resources.buckets || []).length > 0 ||
    Boolean(state.infra?.objectStorage) ||
    composeHasServiceOrVolume(compose, "rustfs", "rustfs_data");
}

function pubsubWanted(resources, compose) {
  return (resources.topics || []).length > 0 ||
    composeHasServiceOrVolume(compose, "nsqd", "nsq_data");
}

function composeHasServiceOrVolume(compose, serviceName, volumeName) {
  const text = String(compose?.composeFile || "");
  if (!text) return false;
  const servicePattern = new RegExp(`(^|\\n)\\s{2}${escapeRegExp(serviceName)}\\s*:`);
  const volumePattern = new RegExp(`(^|\\n|[-\\s])${escapeRegExp(volumeName)}(?::|\\s*:|/)`);
  return servicePattern.test(text) || volumePattern.test(text);
}

function postgresSettings(config, state, env, postgres) {
  const current = state.infra?.postgres || {};
  return {
    appName: postgres?.appName || current.appName || `${config.app.slug}-postgres`,
    database: postgres?.databaseName || current.database || config.app.slug.replaceAll("-", "_"),
    user: postgres?.databaseUser || current.user || "nstack",
    password: current.password || env.NSTACK_POSTGRES_PASSWORD || postgres?.databasePassword || postgres?.password || "",
  };
}

function redisSettings(config, state, env, redis) {
  const current = state.infra?.redis || {};
  return {
    appName: redis?.appName || current.appName || `${config.app.slug}-redis`,
    password: current.password || env.NSTACK_REDIS_PASSWORD || redis?.databasePassword || redis?.password || "",
  };
}

function redisVolumeName(redis, appName) {
  const mount = asList(redis?.mounts).find((item) => item?.type === "volume" && (item.mountPath === "/data" || item.target === "/data"));
  return mount?.volumeName || `${appName}-data`;
}

function resolveBackupDir(cwd, config, options, stamp) {
  if (options.output) return path.resolve(cwd, options.output);
  return path.join(cwd, ".nstack", "backups", config.deploy.target, stamp);
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "utc",
  ].join("-");
}

function stampToIso(stamp) {
  const [year, month, day, hour, minute, second] = stamp.split("-");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printBackupReport(report) {
  console.log(`Backed up ${report.app} (${report.target}) to ${report.backupDir}`);
  console.log(`  size: ${report.size}`);
  console.log(`  snapshot: ${Object.values(report.files).filter(Boolean).join(", ")}`);
  console.log(`  postgres: ${dataLine(report.data.postgres)}`);
  console.log(`  redis: ${dataLine(report.data.redis)}`);
  console.log(`  object storage: ${dataLine(report.data.objectStorage)}`);
  console.log(`  pubsub: ${dataLine(report.data.pubsub)}`);
}

function dataLine(value = {}) {
  if (value.status === "ok") return `${path.basename(value.file)} (${value.size || formatBytes(value.bytes)})`;
  return `${value.status}${value.reason ? ` - ${value.reason}` : ""}`;
}
