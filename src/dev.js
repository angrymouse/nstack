import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { aiDevServerAllowed, detectAgentHarness, devServerGuardMessage } from "./harness.js";
import { runClientGenerator, startClientWatcher } from "./client.js";
import { ensureLocalReady, isNstackApp } from "./setup.js";
import { fileExists } from "./util.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const shell = process.platform === "win32";

export function hasDevRunner(cwd) {
  return isNstackApp(cwd)
    && fileExists(path.join(cwd, "backend", "encore.app"))
    && fileExists(path.join(cwd, "frontend", "package.json"));
}

export function hasDevExecRunner(cwd) {
  return hasDevRunner(cwd);
}

export async function runDev(cwd, args = [], options = {}) {
  if (!hasDevRunner(cwd)) {
    throw new Error("nstack dev requires an nstack app root with backend and frontend workspaces. Run it from an app root or pass --cwd <app>.");
  }
  const harness = detectAgentHarness();
  if (harness.detected && !aiDevServerAllowed()) {
    throw new Error(devServerGuardMessage(harness));
  }

  ensureLocalReady(cwd);

  const stack = createDevStack(cwd, { verbose: !options.capture });
  const signalHandlers = installSignalHandlers(stack);
  try {
    stack.spawn("backend", "pnpm", ["--dir", "backend", "dev"]);
    runClientGenerator(cwd, "gen");
    stack.watchClient();
    stack.spawn("frontend", "pnpm", ["--dir", "frontend", "dev"], frontendDevEnv("http://localhost:4000"));
    const exit = await stack.waitForFirstExit();
    if (exit.signal) process.kill(process.pid, exit.signal);
    if (exit.code) throw new Error(`${exit.name} exited with code ${exit.code}.`);
  } finally {
    signalHandlers.remove();
    await stack.stop();
  }
  return { mode: "cli", harness };
}

export async function runDevExec(cwd, args = [], options = {}) {
  if (!hasDevExecRunner(cwd)) {
    throw new Error("nstack devexec requires an nstack app root with backend and frontend workspaces. Run it from an app root or pass --cwd <app>.");
  }
  const harness = detectAgentHarness();
  const devexec = createDevExec(cwd, args, options);
  const stack = createDevStack(cwd, { verbose: Boolean(process.env.NSTACK_DEVEXEC_VERBOSE || process.env.NSTACK_DEBUG) });
  const signalHandlers = installSignalHandlers(stack);

  try {
    ensureLocalReady(cwd);
    await prepareDevStackOptions(devexec);
    startDevExecStack(stack, devexec);
    await waitForDevStack(stack, devexec);
    const result = await runUserCode(devexec);
    await printResult(result);
    return {
      mode: "cli",
      harness,
      frontendURL: devexec.frontendURL,
      backendURL: devexec.backendURL,
      apiURL: devexec.apiURL,
    };
  } finally {
    signalHandlers.remove();
    await stack.stop();
  }
}

function createDevStack(cwd, { verbose = false } = {}) {
  const children = [];
  let clientWatcher = null;
  let stopping = false;

  return {
    spawn(name, command, args, env = {}) {
      const child = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32" && !verbose,
        stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
        shell,
        env: { ...process.env, ...env },
      });
      child.__nstackName = name;
      child.__nstackExit = null;
      child.__nstackLog = "";
      if (!verbose) {
        child.stdout?.on("data", (chunk) => appendChildLog(child, chunk));
        child.stderr?.on("data", (chunk) => appendChildLog(child, chunk));
      }
      child.on("exit", (code, signal) => {
        child.__nstackExit = { code, signal };
      });
      child.on("error", (error) => {
        child.__nstackExit = { error };
      });
      children.push(child);
      return child;
    },
    watchClient() {
      clientWatcher = startClientWatcher(cwd, { quietUnchanged: true });
      return clientWatcher;
    },
    throwIfChildExited() {
      const child = children.find((item) => item.__nstackExit);
      if (!child) return;
      const exit = child.__nstackExit;
      if (exit.error) throw new Error(`${child.__nstackName} failed to start: ${exit.error.message}${childLogText(child)}`);
      throw new Error(`${child.__nstackName} exited before devexec completed${exit.signal ? ` with signal ${exit.signal}` : ` with code ${exit.code ?? 0}`}${childLogText(child)}`);
    },
    waitForFirstExit() {
      return new Promise((resolve) => {
        for (const child of children) {
          if (child.__nstackExit) {
            resolve({ name: child.__nstackName, ...child.__nstackExit });
            return;
          }
          child.once("exit", (code, signal) => resolve({ name: child.__nstackName, code, signal }));
          child.once("error", (error) => resolve({ name: child.__nstackName, code: 1, error }));
        }
      });
    },
    async stop(signal = "SIGTERM") {
      if (stopping) return;
      stopping = true;
      clientWatcher?.close();
      for (const child of children) signalChild(child, signal);
      await Promise.race([
        Promise.all(children.map(waitForChildClose)),
        sleep(3000),
      ]);
      for (const child of children) signalChild(child, "SIGKILL");
    },
  };
}

function startDevExecStack(stack, options) {
  const backendPort = urlPort(options.backendURL, 4000);
  const frontendPort = urlPort(options.frontendURL, getFrontendPortFallback());
  stack.spawn("backend", "pnpm", ["--dir", "backend", "dev"], {
    ENCORE_LOCAL_PORT: String(backendPort),
  });

  runClientGenerator(options.cwd, "gen");
  stack.watchClient();
  stack.spawn(
    "frontend",
    "pnpm",
    ["--dir", "frontend", "exec", "nuxt", "dev", "--host", "0.0.0.0", "--port", String(frontendPort)],
    frontendDevEnv(options.apiURL),
  );
}

function frontendDevEnv(backendURL) {
  return {
    NUXT_PUBLIC_API_BASE_URL: "/api",
    NUXT_PUBLIC_NSTACK_API_BASE_URL: "/api",
    NSTACK_PUBLIC_API_BASE_URL: "/api",
    NUXT_API_SERVER_BASE_URL: backendURL,
    NUXT_API_INTERNAL_BASE_URL: backendURL,
    NSTACK_API_BASE_URL: backendURL,
  };
}

function createDevExec(cwd, args, cliOptions) {
  const fallbackFrontendPort = getFrontendPortFallback();
  const options = {
    cwd,
    code: "",
    file: "",
    frontendURL: cleanBaseURL(process.env.NSTACK_DEV_FRONTEND_URL || `http://localhost:${fallbackFrontendPort}`),
    frontendURLExplicit: Boolean(process.env.NSTACK_DEV_FRONTEND_URL),
    backendURL: cleanBaseURL(process.env.NSTACK_DEV_BACKEND_URL || "http://localhost:4000"),
    backendURLExplicit: Boolean(process.env.NSTACK_DEV_BACKEND_URL),
    apiURL: "",
    apiURLExplicit: false,
    waitURL: "",
    waitURLExplicit: false,
    timeoutMs: Number(process.env.NSTACK_DEVEXEC_TIMEOUT_MS || 120_000),
    argv: [],
  };

  applyDevExecOption(options, "code", cliOptions.code);
  applyDevExecOption(options, "file", cliOptions.file);
  applyDevExecOption(options, "baseUrl", cliOptions.baseUrl);
  applyDevExecOption(options, "frontendUrl", cliOptions.frontendUrl);
  applyDevExecOption(options, "backendUrl", cliOptions.backendUrl);
  applyDevExecOption(options, "apiUrl", cliOptions.apiUrl);
  applyDevExecOption(options, "waitUrl", cliOptions.waitUrl);
  applyDevExecOption(options, "timeoutMs", cliOptions.timeoutMs);

  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = camel(rawKey);
    const value = inlineValue !== undefined ? inlineValue : args[i + 1];
    if (inlineValue === undefined) i += 1;
    if (value === undefined) throw new Error(`Missing value for --${rawKey}.`);
    applyDevExecOption(options, key, value, rawKey);
  }

  if (options.file) options.code = readFileSync(path.resolve(cwd, options.file), "utf8");
  if (!options.code && positional.length > 0) options.code = positional.join(" ");
  options.argv = positional;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = 120_000;
  if (!options.code.trim()) {
    throw new Error("Missing JavaScript. Use `nstack devexec 'await apiJson(\"/status\")'` or `nstack devexec --file script.mjs`.");
  }
  return options;
}

function applyDevExecOption(options, key, value, rawKey = key) {
  if (value === undefined || value === null || value === "") return;
  if (key === "code") options.code = value;
  else if (key === "file") options.file = value;
  else if (key === "baseUrl" || key === "frontendUrl") {
    options.frontendURL = cleanBaseURL(value);
    options.frontendURLExplicit = true;
  } else if (key === "backendUrl") {
    options.backendURL = cleanBaseURL(value);
    options.backendURLExplicit = true;
  } else if (key === "apiUrl") {
    options.apiURL = cleanBaseURL(value);
    options.apiURLExplicit = true;
  } else if (key === "waitUrl") {
    options.waitURL = cleanBaseURL(value);
    options.waitURLExplicit = true;
  } else if (key === "timeoutMs") {
    options.timeoutMs = Number(value);
  } else {
    throw new Error(`Unknown devexec option: --${rawKey}`);
  }
}

async function prepareDevStackOptions(options) {
  options.backendURL = await prepareManagedURL(options.backendURL, 4000, options.backendURLExplicit, "Encore backend", "--backend-url");
  options.frontendURL = await prepareManagedURL(options.frontendURL, getFrontendPortFallback(), options.frontendURLExplicit, "Nuxt frontend", "--frontend-url");
  if (!options.apiURLExplicit) options.apiURL = options.backendURL;
  if (!options.waitURLExplicit) options.waitURL = options.frontendURL;
}

async function prepareManagedURL(url, fallbackPort, explicit, label, flag) {
  const port = urlPort(url, fallbackPort);
  if (explicit) {
    if (await isPortAvailable(port)) return url;
    throw new Error(`${label} port ${port} is already in use at ${url}. Stop that process or pass ${flag} with another local port.`);
  }
  const availablePort = await availablePortFrom(port);
  return withURLPort(url, availablePort);
}

async function availablePortFrom(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`Could not find a free local port from ${start} to ${start + 99}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

function getFrontendPortFallback() {
  const paseoPort = Number(process.env.PASEO_PORT);
  return Number.isFinite(paseoPort) && paseoPort > 0 ? paseoPort : 3000;
}

async function waitForDevStack(stack, options) {
  await Promise.all([
    waitForURL(stack, options.backendURL, "Encore backend", options.timeoutMs),
    waitForFrontendURL(stack, options.waitURL, "Nuxt frontend", options.timeoutMs),
  ]);
}

async function waitForURL(stack, url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    stack.throwIfChildExited();
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

async function waitForFrontendURL(stack, url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    stack.throwIfChildExited();
    try {
      const response = await fetchWithTimeout(url, 1000);
      const body = await response.text().catch(() => "");
      const text = body.trim().toLowerCase();
      if ((response.status < 500 || response.status === 404) && text !== "offline") return;
      lastError = text === "offline" ? "received an offline response" : `HTTP ${response.status}`;
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
  api, apiJson, page, pageText, request, requestJson, screenshot, pageScreenshot,
  expectOk, sleep,
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
  const screenshot = (input = "/", screenshotOptions = {}) => screenshotPage(input, screenshotOptions, options);
  return {
    assert,
    fetch,
    frontendURL: options.frontendURL,
    backendURL: options.backendURL,
    apiURL: options.apiURL,
    baseURL: options.frontendURL,
    root: options.cwd,
    env: process.env,
    argv: options.argv,
    api,
    apiJson: async (input = "/", init = {}) => responseJson(await api(input, init), `api ${input}`),
    page: request,
    pageText: async (input = "/", init = {}) => responseText(await request(input, init), `page ${input}`),
    request,
    requestJson: async (input = "/", init = {}) => responseJson(await request(input, init), `request ${input}`),
    screenshot,
    pageScreenshot: screenshot,
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

async function screenshotPage(input = "/", screenshotOptions = {}, options) {
  if (typeof input === "object" && input !== null) {
    screenshotOptions = input;
    input = screenshotOptions.url || screenshotOptions.route || "/";
  }
  const targetURL = resolveURL(input, options.frontendURL);
  const viewport = normalizeViewport(screenshotOptions);
  const outputPath = screenshotOutputPath(input, screenshotOptions, options.cwd);
  const { chromium } = loadPlaywright(options.cwd);
  let browser;
  try {
    browser = await launchChromium(chromium, screenshotOptions, options.cwd);
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: Number(screenshotOptions.deviceScaleFactor || 1),
    });
    await page.goto(targetURL, {
      waitUntil: screenshotOptions.waitUntil || "networkidle",
      timeout: Number(screenshotOptions.timeoutMs || screenshotOptions.timeout || 30_000),
    });
    if (screenshotOptions.selector) {
      await page.waitForSelector(String(screenshotOptions.selector), {
        timeout: Number(screenshotOptions.selectorTimeoutMs || screenshotOptions.timeoutMs || 15_000),
      });
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    await page.screenshot({
      path: outputPath,
      fullPage: screenshotOptions.fullPage !== false,
      type: screenshotOptions.type || undefined,
    });
    await page.close();
    return {
      path: outputPath,
      url: targetURL,
      width: viewport.width,
      height: viewport.height,
      fullPage: screenshotOptions.fullPage !== false,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function launchChromium(chromium, options = {}, cwd) {
  const launchOptions = playwrightLaunchOptions(options);
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (!isPlaywrightLaunchError(error) || launchOptions.executablePath) throw error;
    installPlaywrightChromium(cwd);
    try {
      return await chromium.launch(launchOptions);
    } catch (retryError) {
      throw new Error(`Playwright could not start Chromium after installing it. ${retryError.message}`);
    }
  }
}

function installPlaywrightChromium(cwd) {
  console.error("Installing Playwright Chromium for devexec screenshots...");
  const install = spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
    cwd,
    stdio: "inherit",
    shell,
  });
  if (install.status !== 0) {
    throw new Error(`Playwright Chromium installation failed with exit code ${install.status || 1}.`);
  }
}

function loadPlaywright(cwd) {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    return require("playwright");
  } catch (error) {
    throw new Error(`Playwright is not installed. Run \`pnpm install\` from the app root, then retry devexec screenshots. ${error.message}`);
  }
}

function normalizeViewport(options = {}) {
  const source = options.viewport || options;
  return {
    width: positiveNumber(source.width, 1440),
    height: positiveNumber(source.height, 1000),
  };
}

function screenshotOutputPath(input, options = {}, cwd) {
  const explicit = options.path || options.output;
  if (explicit) return path.resolve(cwd, String(explicit));
  const dir = options.dir ? path.resolve(cwd, String(options.dir)) : path.join(cwd, ".nstack", "screenshots");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}-${safeScreenshotName(input)}.png`);
}

function safeScreenshotName(input) {
  return String(input || "page")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "page";
}

function playwrightLaunchOptions(options = {}) {
  const launch = {
    headless: options.headless !== false,
  };
  const executablePath = options.executablePath || process.env.NSTACK_PLAYWRIGHT_EXECUTABLE_PATH;
  if (executablePath) launch.executablePath = String(executablePath);
  return launch;
}

function isPlaywrightLaunchError(error) {
  return error instanceof Error && /browser|chromium|executable|install/i.test(error.message);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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

function appendChildLog(child, chunk) {
  child.__nstackLog += chunk.toString();
  if (child.__nstackLog.length > 6000) child.__nstackLog = child.__nstackLog.slice(-6000);
}

function childLogText(child) {
  const log = String(child.__nstackLog || "").trim();
  return log ? `:\n${log}` : ".";
}

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill(signal);
  }
}

function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function installSignalHandlers(stack) {
  const stopForSignal = (signal) => {
    void stack.stop(signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const onSigint = () => stopForSignal("SIGINT");
  const onSigterm = () => stopForSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    remove() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

function cleanBaseURL(value) {
  return String(value || "").replace(/\/+$/, "");
}

function withURLPort(url, port) {
  const parsed = new URL(url);
  parsed.port = String(port);
  return cleanBaseURL(parsed.toString());
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
