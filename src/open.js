import { spawn } from "node:child_process";
import { loadConfig, targetFromOptions } from "./config.js";

export async function openTarget(args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const kind = normalizeOpenTarget(args[0] || (options.dashboard ? "dashboard" : "app"));
  const url = targetUrl(kind, config);
  const shouldLaunch = !options.json && !options.print && !options.noBrowser;
  const opened = shouldLaunch ? launchBrowser(url) : false;
  const report = {
    app: config.app.slug,
    target: config.deploy.target,
    kind,
    url,
    opened,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(opened ? `Opened ${url}` : url);
  return report;
}

function normalizeOpenTarget(value) {
  const target = String(value || "app").toLowerCase();
  if (target === "app" || target === "url" || target === "site") return "app";
  if (target === "dashboard" || target === "dokploy" || target === "panel") return "dashboard";
  throw new Error(`Unknown open target: ${value}. Use app or dashboard.`);
}

function targetUrl(kind, config) {
  if (kind === "dashboard") {
    if (!config.deploy.provider.url) throw new Error("Dokploy URL is missing. Run `nstack configure --dokploy-url <url>`.");
    return config.deploy.provider.url;
  }
  if (!config.app.domain) throw new Error("App domain is missing. Run `nstack configure --domain <domain>`.");
  return `https://${config.app.domain}`;
}

function launchBrowser(url) {
  try {
    const { command, args } = browserCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function browserCommand(url) {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}
