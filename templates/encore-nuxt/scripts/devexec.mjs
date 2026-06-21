#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureLocalReady, root, shell } from "./nstack-local.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const children = [];

let stopping = false;

process.on("SIGINT", () => stopForSignal("SIGINT"));
process.on("SIGTERM", () => stopForSignal("SIGTERM"));

const code = await runMain();
process.exitCode = code;

async function runMain() {
  let exitCode = 0;
  try {
    const options = parseDevExecArgs(process.argv.slice(2));
    await ensureLocalReady();
    startDevStack(options);
    await waitForDevStack(options);
    const result = await runUserCode(options);
    await printResult(result);
  } catch (error) {
    exitCode = 1;
    console.error(errorText(error));
  } finally {
    await stopChildren();
  }
  return exitCode;
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  if (process.env.NSTACK_DEBUG || process.env.NSTACK_DEVEXEC_DEBUG) return error.stack || error.message;
  return error.message;
}

function parseDevExecArgs(argv) {
  const options = {
    code: "",
    file: "",
    frontendURL: cleanBaseURL(process.env.NSTACK_DEV_FRONTEND_URL || "http://localhost:3000"),
    backendURL: cleanBaseURL(process.env.NSTACK_DEV_BACKEND_URL || "http://localhost:4000"),
    apiURL: "",
    waitURL: "",
    timeoutMs: Number(process.env.NSTACK_DEVEXEC_TIMEOUT_MS || 120_000),
    argv: [],
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = camel(rawKey);
    const value = inlineValue !== undefined ? inlineValue : argv[i + 1];
    if (inlineValue === undefined) i += 1;
    if (value === undefined) throw new Error(`Missing value for --${rawKey}.`);
    if (key === "code") options.code = value;
    else if (key === "file") options.file = value;
    else if (key === "baseUrl" || key === "frontendUrl") options.frontendURL = cleanBaseURL(value);
    else if (key === "backendUrl") options.backendURL = cleanBaseURL(value);
    else if (key === "apiUrl") options.apiURL = cleanBaseURL(value);
    else if (key === "waitUrl") options.waitURL = cleanBaseURL(value);
    else if (key === "timeoutMs") options.timeoutMs = Number(value);
    else throw new Error(`Unknown devexec option: --${rawKey}`);
  }

  if (options.file) options.code = readFileSync(options.file, "utf8");
  if (!options.code && positional.length > 0) options.code = positional.join(" ");
  options.argv = positional;
  options.apiURL ||= options.backendURL;
  options.waitURL ||= options.frontendURL;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = 120_000;
  if (!options.code.trim()) {
    throw new Error("Missing JavaScript. Use `nstack devexec 'await apiJson(\"/status\")'` or `nstack devexec --file script.mjs`.");
  }
  return options;
}

function startDevStack(options) {
  const backendPort = urlPort(options.backendURL, 4000);
  const frontendPort = urlPort(options.frontendURL, 3000);
  spawnManaged("backend", "pnpm", ["--dir", "backend", "dev"], {
    ENCORE_LOCAL_PORT: String(backendPort),
  });

  const initial = spawnSync(process.execPath, ["scripts/nstack-client.mjs", "gen"], {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (initial.status !== 0) throw new Error(`Encore client generation failed with exit code ${initial.status || 1}.`);

  spawnManaged("client", process.execPath, ["scripts/nstack-client.mjs", "watch"]);
  spawnManaged("frontend", "pnpm", ["--dir", "frontend", "dev", "--", "--host", "0.0.0.0", "--port", String(frontendPort)], {
    NUXT_PUBLIC_API_BASE_URL: options.apiURL,
    NUXT_PUBLIC_NSTACK_API_BASE_URL: options.apiURL,
    NSTACK_PUBLIC_API_BASE_URL: options.apiURL,
    NUXT_API_SERVER_BASE_URL: options.apiURL,
    NUXT_API_INTERNAL_BASE_URL: options.apiURL,
    NSTACK_API_BASE_URL: options.apiURL,
  });
}

async function waitForDevStack(options) {
  await Promise.all([
    waitForURL(options.backendURL, "Encore backend", options.timeoutMs),
    waitForURL(options.waitURL, "Nuxt frontend", options.timeoutMs),
  ]);
}

async function waitForURL(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    throwIfChildExited();
    try {
      const response = await fetchWithTimeout(url, 1000);
      if (response.status < 500 || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}${lastError ? `: ${lastError}` : ""}`);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runUserCode(options) {
  const context = devExecContext(options);
  const fn = compileUserCode(options.code);
  return await fn(context);
}

function compileUserCode(code) {
  const prelude = `const {
  assert, fetch, frontendURL, backendURL, apiURL, baseURL, root, env, argv,
  api, apiJson, page, pageText, request, requestJson, expectOk, sleep,
  console, URL, URLSearchParams, Headers, Request, Response, FormData
} = ctx;\n`;
  try {
    return new AsyncFunction("ctx", `${prelude}return (${code}\n);`);
  } catch {
    return new AsyncFunction("ctx", `${prelude}${code}\n`);
  }
}

function devExecContext(options) {
  const request = (input = "/", init = {}) => fetch(resolveURL(input, options.frontendURL), init);
  const api = (input = "/", init = {}) => fetch(resolveURL(input, options.apiURL), init);
  return {
    assert,
    fetch,
    frontendURL: options.frontendURL,
    backendURL: options.backendURL,
    apiURL: options.apiURL,
    baseURL: options.frontendURL,
    root,
    env: process.env,
    argv: options.argv,
    api,
    apiJson: async (input = "/", init = {}) => responseJson(await api(input, init), `api ${input}`),
    page: request,
    pageText: async (input = "/", init = {}) => responseText(await request(input, init), `page ${input}`),
    request,
    requestJson: async (input = "/", init = {}) => responseJson(await request(input, init), `request ${input}`),
    expectOk,
    sleep,
    console,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    FormData,
  };
}

async function responseJson(response, label = "request") {
  await expectOk(response, label);
  return await response.json();
}

async function responseText(response, label = "request") {
  await expectOk(response, label);
  return await response.text();
}

async function expectOk(response, label = "request") {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new Error(`${label} failed with HTTP ${response.status}${body ? `:\n${body.slice(0, 1000)}` : ""}`);
}

function resolveURL(input, base) {
  const value = String(input || "/");
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, `${cleanBaseURL(base)}/`).toString();
}

async function printResult(result) {
  if (result === undefined) return;
  if (result instanceof Response) {
    const body = await result.text();
    console.log(JSON.stringify({
      ok: result.ok,
      status: result.status,
      headers: Object.fromEntries(result.headers.entries()),
      body,
    }, null, 2));
    return;
  }
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function spawnManaged(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell,
    env: { ...process.env, ...env },
  });
  child.__nstackName = name;
  child.__nstackExit = null;
  child.on("exit", (code, signal) => {
    child.__nstackExit = { code, signal };
  });
  child.on("error", (error) => {
    child.__nstackExit = { error };
  });
  children.push(child);
  return child;
}

function throwIfChildExited() {
  const child = children.find((item) => item.__nstackExit);
  if (!child) return;
  const exit = child.__nstackExit;
  if (exit.error) throw new Error(`${child.__nstackName} failed to start: ${exit.error.message}`);
  throw new Error(`${child.__nstackName} exited before devexec completed${exit.signal ? ` with signal ${exit.signal}` : ` with code ${exit.code ?? 0}`}.`);
}

async function stopChildren(signal = "SIGTERM") {
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  await Promise.race([
    Promise.all(children.map(waitForChildClose)),
    sleep(3000),
  ]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function stopForSignal(signal) {
  if (stopping) return;
  void stopChildren(signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}

function cleanBaseURL(value) {
  return String(value || "").replace(/\/+$/, "");
}

function urlPort(url, fallback) {
  try {
    const parsed = new URL(url);
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    return fallback;
  }
}

function camel(key) {
  return key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
