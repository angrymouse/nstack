import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "./util.js";

const schemaVersion = 1;
const addNewValue = "__nstack_add_dokploy_instance__";

export const dokployInstanceEnv = "NSTACK_DOKPLOY_INSTANCE";

export function dokployInstancesPath() {
  if (process.env.NSTACK_DOKPLOY_INSTANCES_FILE) return process.env.NSTACK_DOKPLOY_INSTANCES_FILE;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "nstack", "dokploy-instances.json");
}

export function loadDokployInstances(file = dokployInstancesPath()) {
  const data = readJSON(file, { version: schemaVersion, instances: [] });
  const rawInstances = Array.isArray(data) ? data : data?.instances;
  if (!Array.isArray(rawInstances)) return [];

  const seenUrls = new Set();
  const instances = [];
  for (const item of rawInstances) {
    const instance = normalizeDokployInstance(item, { requireApiKey: false });
    if (!instance.url) continue;
    const key = instance.url.toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    instances.push(instance);
  }
  return instances;
}

export function saveDokployInstance(instance, file = dokployInstancesPath()) {
  const normalized = normalizeDokployInstance(instance);
  if (!normalized.url) throw new Error("Dokploy instance URL is required.");
  if (!normalized.apiKey) throw new Error("Dokploy instance API key is required.");

  const instances = loadDokployInstances(file)
    .filter((item) => item.url.toLowerCase() !== normalized.url.toLowerCase());
  instances.push(normalized);
  writeJSON(file, { version: schemaVersion, instances });
  return normalized;
}

export async function promptDokployInstance(prompter, { url = "", apiKey = "", file = dokployInstancesPath() } = {}) {
  const envUrl = process.env.DOKPLOY_URL || "";
  const envApiKey = process.env.DOKPLOY_API_KEY || "";
  let selectedUrl = normalizeDokployUrl(url || envUrl);
  let selectedApiKey = String(apiKey || envApiKey || "").trim();

  if (selectedUrl && selectedApiKey) {
    return normalizeDokployInstance({ url: selectedUrl, apiKey: selectedApiKey });
  }

  const instances = loadDokployInstances(file);
  if (selectedUrl && !selectedApiKey) {
    const saved = findDokployInstanceByUrl(instances, selectedUrl);
    if (saved?.apiKey) return saved;
    selectedApiKey = await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true });
    return normalizeDokployInstance({ url: selectedUrl, apiKey: selectedApiKey });
  }

  if (!selectedUrl && selectedApiKey) {
    selectedUrl = normalizeDokployUrl(await prompter.ask("DOKPLOY_URL", "Dokploy URL"));
    return normalizeDokployInstance({ url: selectedUrl, apiKey: selectedApiKey });
  }

  const selector = process.env[dokployInstanceEnv] || "";
  if (selector) {
    const selected = resolveDokployInstanceSelection(selector, instances);
    if (selected === addNewValue) return promptAndSaveDokployInstance(prompter, { file });
    if (selected) return selected;
    throw new Error(`Unknown Dokploy instance: ${selector}`);
  }

  if (prompter.yes) {
    selectedUrl = normalizeDokployUrl(await prompter.ask("DOKPLOY_URL", "Dokploy URL"));
    selectedApiKey = await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true });
    return normalizeDokployInstance({ url: selectedUrl, apiKey: selectedApiKey });
  }

  const choices = dokployInstanceChoices(instances);
  const choice = await prompter.select(dokployInstanceEnv, "Dokploy instance", choices, { defaultIndex: 0 });
  if (choice.value === addNewValue) return promptAndSaveDokployInstance(prompter, { file });
  if (!choice.instance.apiKey) {
    const savedApiKey = await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true });
    return saveDokployInstance({ ...choice.instance, apiKey: savedApiKey }, file);
  }
  return choice.instance;
}

export async function promptAndSaveDokployInstance(prompter, { file = dokployInstancesPath() } = {}) {
  const url = normalizeDokployUrl(await prompter.ask("DOKPLOY_URL", "Dokploy URL"));
  const apiKey = await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true });
  const defaultName = defaultDokployInstanceName(url);
  const name = await prompter.askOptional("NSTACK_DOKPLOY_INSTANCE_NAME", "Dokploy instance name", { defaultValue: defaultName });
  return saveDokployInstance({ name, url, apiKey }, file);
}

export function normalizeDokployInstance(instance = {}, { requireApiKey = true } = {}) {
  const url = normalizeDokployUrl(instance.url || instance.dokployUrl || "");
  const apiKey = String(instance.apiKey || instance.dokployApiKey || "").trim();
  if (requireApiKey && url && !apiKey) return { name: defaultDokployInstanceName(url), url, apiKey: "" };
  const name = String(instance.name || defaultDokployInstanceName(url)).trim() || defaultDokployInstanceName(url);
  return { name, url, apiKey };
}

export function normalizeDokployUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  return withProtocol.replace(/\/+$/, "");
}

function dokployInstanceChoices(instances) {
  return [
    ...instances.map((instance) => ({
      label: dokployInstanceLabel(instance),
      value: instance.url,
      instance,
    })),
    { label: "Add new", value: addNewValue },
  ];
}

function resolveDokployInstanceSelection(selector, instances) {
  const value = String(selector || "").trim();
  if (["add", "add-new", "new", "Add new"].includes(value)) return addNewValue;
  const lower = value.toLowerCase();
  return instances.find((instance) => (
    instance.name.toLowerCase() === lower
      || instance.url.toLowerCase() === lower
      || dokployInstanceLabel(instance).toLowerCase() === lower
  )) || null;
}

function findDokployInstanceByUrl(instances, url) {
  const normalized = normalizeDokployUrl(url).toLowerCase();
  return instances.find((instance) => instance.url.toLowerCase() === normalized) || null;
}

function dokployInstanceLabel(instance) {
  return instance.name && instance.name !== instance.url
    ? `${instance.name} (${instance.url})`
    : instance.url;
}

function defaultDokployInstanceName(url) {
  if (!url) return "Dokploy";
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || "Dokploy";
  }
}
