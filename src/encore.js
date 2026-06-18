import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { commandOutput } from "./util.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

export async function discoverEncoreResources(backendDir) {
  const root = path.resolve(backendDir);
  try {
    return resourcesFromMetadata(parseEncoreMetadata(commandOutput("encore", ["debug", "meta", "-f", "json"], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    })), root);
  } catch (error) {
    const fallback = resourcesFromSource(root);
    fallback.metadataError = error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

function parseEncoreMetadata(output) {
  const source = stripAnsi(String(output || ""));
  const start = source.indexOf("{");
  if (start === -1) throw new Error("Encore metadata output did not contain JSON.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new Error("Encore metadata output contained incomplete JSON.");
}

function stripAnsi(value) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function resourcesFromMetadata(meta, backendDir) {
  const services = (meta.svcs || []).map((service) => ({
    name: service.name,
    relPath: service.rel_path || service.name,
    endpoints: (service.rpcs || []).map((rpc) => ({
      service: service.name,
      name: rpc.name,
      path: pathToString(rpc.path),
      method: rpc.http_methods?.[0] || "POST",
      exposed: Boolean(rpc.expose && Object.keys(rpc.expose).length > 0),
    })),
  }));

  return {
    source: "encore-metadata",
    backendDir,
    metadata: meta,
    services,
    databases: (meta.sql_databases || []).map((database) => ({
      name: database.name,
      migrations: database.migration_rel_path || "",
    })),
    caches: (meta.cache_clusters || []).map((cache) => ({
      name: cache.name,
      evictionPolicy: cache.eviction_policy || "allkeys-lru",
    })),
    topics: (meta.pubsub_topics || []).map((topic) => ({
      name: topic.name,
      subscriptions: (topic.subscriptions || []).map((subscription) => ({
        name: subscription.name,
        service: subscription.service_name,
      })),
    })),
    buckets: (meta.buckets || []).map((bucket) => ({
      name: bucket.name,
      public: Boolean(bucket.public),
      versioned: Boolean(bucket.versioned),
    })),
    secrets: [...new Set((meta.pkgs || []).flatMap((pkg) => pkg.secrets || []))].sort(),
    crons: (meta.cron_jobs || []).map((cron) => ({
      name: cron.id,
      title: cron.title || cron.id,
      schedule: cron.schedule || (cron.every ? `every:${cron.every}` : ""),
      normalizedSchedule: normalizeSchedule(cron.schedule || (cron.every ? `every:${cron.every}` : "")),
      endpoint: endpointForCron(meta, cron.endpoint),
    })),
  };
}

function pathToString(routePath) {
  if (!routePath?.segments?.length) return "/";
  return `/${routePath.segments.map((segment) => {
    if (segment.type === "PARAM") return `:${segment.value}`;
    if (segment.type === "WILDCARD" || segment.type === "FALLBACK") return `*${segment.value || "path"}`;
    return segment.value;
  }).join("/")}`;
}

function endpointForCron(meta, qualifiedName) {
  if (!qualifiedName) return null;
  for (const service of meta.svcs || []) {
    if (service.rel_path !== qualifiedName.pkg && service.name !== qualifiedName.pkg) continue;
    const rpc = (service.rpcs || []).find((entry) => entry.name === qualifiedName.name);
    if (!rpc) continue;
    return {
      service: service.name,
      name: rpc.name,
      path: pathToString(rpc.path),
      method: rpc.http_methods?.[0] || "POST",
    };
  }
  return {
    service: qualifiedName.pkg,
    name: qualifiedName.name,
    path: `/${qualifiedName.pkg}.${qualifiedName.name}`,
    method: "POST",
  };
}

function normalizeSchedule(schedule) {
  const value = String(schedule || "").trim();
  if (value.startsWith("every:")) {
    return { kind: "every", minutes: parseEveryMinutes(value.slice("every:".length)), value: value.slice("every:".length) };
  }
  if (value.startsWith("schedule:")) {
    return { kind: "schedule", value: value.slice("schedule:".length) };
  }
  return { kind: "schedule", value };
}

function resourcesFromSource(backendDir) {
  const files = walk(backendDir);
  const fileEntries = files.map((file) => ({ file, content: readFileSync(file, "utf8") }));
  const content = fileEntries.map((entry) => entry.content).join("\n");
  const hasGateway = /\bnew\s+Gateway\s*\(/.test(content);
  return {
    source: "source-scan",
    backendDir,
    metadata: hasGateway ? { gateways: [{ encore_name: "api-gateway" }] } : {},
    services: sourceServices(backendDir, fileEntries),
    databases: matches(content, /new\s+SQLDatabase\s*\(\s*["'`]([^"'`]+)["'`]/g).map((name) => ({ name })),
    caches: matches(content, /new\s+(?:CacheCluster|RedisCache|Cache)\s*\(\s*["'`]([^"'`]+)["'`]/g).map((name) => ({ name })),
    topics: matches(content, /new\s+Topic\s*\(\s*["'`]([^"'`]+)["'`]/g).map((name) => ({ name, subscriptions: [] })),
    buckets: matches(content, /new\s+Bucket\s*\(\s*["'`]([^"'`]+)["'`]/g).map((name) => ({ name })),
    secrets: [...new Set(matches(content, /(?:secret|Secret)\s*(?:<[^>]+>)?\s*\(\s*["'`]([^"'`]+)["'`]/g))].sort(),
    crons: sourceCrons(content),
  };
}

function sourceServices(backendDir, entries) {
  const names = new Set();
  for (const { file, content } of entries) {
    if (!/\bapi(?:\.raw)?\s*\(|\bnew\s+(?:SQLDatabase|Topic|CronJob)\s*\(/.test(content)) continue;
    const [service] = path.relative(backendDir, file).split(path.sep);
    if (service && service !== "." && service !== "..") names.add(service);
  }
  return [...names].sort().map((name) => ({ name, relPath: name, endpoints: [] }));
}

function sourceCrons(content) {
  const crons = [];
  const pattern = /new\s+CronJob\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    const schedule = stringProperty(body, "schedule");
    const every = stringProperty(body, "every") || numberProperty(body, "every");
    const value = schedule || (every ? `every:${every}` : "");
    crons.push({
      name,
      schedule: value,
      normalizedSchedule: normalizeSchedule(value),
    });
  }
  return crons;
}

function stringProperty(content, name) {
  const match = content.match(new RegExp(`${name}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
  return match?.[1] || "";
}

function numberProperty(content, name) {
  const match = content.match(new RegExp(`${name}\\s*:\\s*(\\d+)`));
  return match?.[1] || "";
}

function parseEveryMinutes(value) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (!match) return NaN;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return amount / 60;
  if (unit.startsWith("m")) return amount;
  if (unit.startsWith("h")) return amount * 60;
  return amount * 1440;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".encore" || entry.name === "encore.gen") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out.filter((file) => statSync(file).size < 2_000_000);
}

function matches(content, pattern) {
  return [...content.matchAll(pattern)].map((match) => match[1]);
}
