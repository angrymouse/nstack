import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON } from "./util.js";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function packageInfo() {
  return readJSON(path.join(packageRoot, "package.json"), {});
}

export function currentVersion() {
  return packageInfo().version || "0.0.0";
}

export function versionReport() {
  const pkg = packageInfo();
  return {
    name: pkg.name || "nstack",
    version: pkg.version || "0.0.0",
  };
}

export function printVersion(options = {}) {
  const report = versionReport();
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.name} ${report.version}`);
  return report;
}
