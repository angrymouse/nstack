import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ensureDir, run, writeText } from "./util.js";

const thinBuildDir = ".encore/nstack";
const bundledMain = "combined/main.mjs";

export function buildBackendImage({ config, cwd, image, infraFile, platform, quiet = false, timings = null }) {
  buildThinBackendImage({ config, cwd, image, infraFile, platform, quiet, timings });
}

function buildThinBackendImage({ config, cwd, image, infraFile, platform, quiet, timings }) {
  const backendDir = path.join(cwd, config.paths.backend);
  const buildDir = path.join(backendDir, thinBuildDir);
  const bundleDir = path.join(buildDir, "bundle");
  const contextDir = path.join(buildDir, "image");
  const entrypoint = "encore.gen/internal/entrypoints/combined/main.ts";

  timed("backend: encore wrappers", quiet, timings, () => {
    run("encore", ["gen", "wrappers"], { cwd: backendDir, capture: quiet });
  });
  assertFile(path.join(backendDir, entrypoint), "Encore combined entrypoint");

  rmSync(bundleDir, { recursive: true, force: true });
  timed("backend: bundle", quiet, timings, () => {
    run("tsbundler-encore", [
      "--bundle",
      "--engine=node:22",
      `--outdir=${path.relative(backendDir, bundleDir)}`,
      entrypoint,
    ], { cwd: backendDir, capture: quiet });
  });
  assertFile(path.join(bundleDir, bundledMain), "bundled backend entrypoint");

  stageThinContext({ config, backendDir, bundleDir, contextDir, infraFile, arch: platform.arch, quiet, timings });

  if (!quiet) console.log(`Building backend ${image}`);
  timed("backend: docker build", quiet, timings, () => run("docker", [
    "build",
    "--platform",
    platform.value,
    "-t", image,
    "-f", path.join(contextDir, "Dockerfile"),
    contextDir,
  ], { cwd, capture: quiet }));
  timed("backend: docker push", quiet, timings, () => {
    run("docker", ["push", image], { cwd, capture: quiet });
  });
}

function stageThinContext({ config, backendDir, bundleDir, contextDir, infraFile, arch, quiet, timings }) {
  const appMeta = timed("backend: prepare app metadata", quiet, timings, () => encoreAppMeta(backendDir));
  const runtimeLib = timed("backend: resolve runtime binary", quiet, timings, () => encoreRuntimeLib({ backendDir, arch }));
  const runtimePackage = timed("backend: resolve runtime package", quiet, timings, () => encoreRuntimePackage({ backendDir }));

  timed("backend: stage image files", quiet, timings, () => {
    rmSync(contextDir, { recursive: true, force: true });
    ensureDir(path.join(contextDir, "workspace/backend/.encore/build/combined"));
    ensureDir(path.join(contextDir, "encore/runtimes/js"));

    cpSync(bundleDir, path.join(contextDir, "workspace/backend/.encore/build/combined"), { recursive: true });
    copyFileSync(path.join(backendDir, "package.json"), path.join(contextDir, "workspace/backend/package.json"));
    copyFileSync(runtimeLib, path.join(contextDir, "encore/runtimes/js/encore-runtime.node"));
    cpSync(runtimePackage, path.join(contextDir, "encore/runtimes/js/encore.dev"), { recursive: true });
    copyFileSync(infraFile, path.join(contextDir, "encore/infra.config.json"));
    writeText(path.join(contextDir, "encore/meta"), appMeta);
    writeText(path.join(contextDir, "encore/build-info.json"), `${JSON.stringify({
      app: config.app.slug,
      builtAt: new Date().toISOString(),
      builder: "nstack-thin",
    }, null, 2)}\n`);
    writeDockerfile(path.join(contextDir, "Dockerfile"));
  });
}

function encoreAppMeta(backendDir) {
  const result = spawnSync("encore", ["debug", "meta", "-f", "proto"], {
    cwd: backendDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.error?.message || result.stderr?.toString("utf8") || result.stdout?.toString("utf8") || "").trim();
    throw new Error(`encore debug meta -f proto failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

function encoreRuntimeLib({ backendDir, arch }) {
  const version = encoreVersion(backendDir);
  const home = homeDir();
  const install = process.env.ENCORE_INSTALL || path.join(home, ".encore");
  const localRuntime = path.join(install, "runtimes/js/encore-runtime.node");
  const cacheRuntime = path.join(home, `.cache/encore/cache/bin/v${version}/linux/${arch}/encore-runtime.node`);
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;

  if (arch === hostArch && existsSync(localRuntime)) return localRuntime;
  if (existsSync(cacheRuntime)) return cacheRuntime;
  throw new Error(`Missing Encore JS runtime for linux/${arch}. Expected ${cacheRuntime}. Run \`encore version update\` or build on the target architecture once.`);
}

function encoreRuntimePackage({ backendDir }) {
  const home = homeDir();
  const install = process.env.ENCORE_INSTALL || path.join(home, ".encore");
  const runtimesPath = process.env.ENCORE_RUNTIMES_PATH || path.join(install, "runtimes");
  const runtimePackage = path.join(runtimesPath, "js/encore.dev");
  if (existsSync(runtimePackage)) return runtimePackage;

  const nodeModulesPackage = path.join(backendDir, "node_modules/encore.dev");
  if (existsSync(nodeModulesPackage)) return nodeModulesPackage;
  throw new Error(`Missing Encore JS runtime package: ${runtimePackage}. Run \`encore version update\`.`);
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function encoreVersion(backendDir) {
  const pkg = JSON.parse(readFileSync(path.join(backendDir, "package.json"), "utf8"));
  const version = pkg.dependencies?.["encore.dev"] || pkg.devDependencies?.["encore.dev"];
  if (!version) throw new Error("backend/package.json does not declare encore.dev.");
  return String(version).replace(/^[^\d]*/, "");
}

function writeDockerfile(file) {
  const nodeImage = process.env.NSTACK_BACKEND_NODE_IMAGE || "node:22-bookworm-slim";
  writeText(file, `FROM ${nodeImage}

RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/backend
ENV NODE_ENV=production
ENV ENCORE_INFRA_CONFIG_PATH=/encore/infra.config.json
ENV ENCORE_APP_META_PATH=/encore/meta
ENV ENCORE_RUNTIME_LIB=/encore/runtimes/js/encore-runtime.node

COPY workspace/backend/package.json ./package.json
COPY encore/runtimes/js/encore.dev ./node_modules/encore.dev
COPY workspace/backend/.encore/build/combined ./.encore/build/combined
COPY encore /encore

ENTRYPOINT ["node", "--enable-source-maps", "/workspace/backend/.encore/build/combined/${bundledMain}"]
`);
}

function assertFile(file, label) {
  try {
    if (statSync(file).isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(`Missing ${label}: ${file}`);
}

function timed(label, quiet, timings, task) {
  const startedAt = performance.now();
  const result = task();
  const durationMs = performance.now() - startedAt;
  if (timings) timings.push({ name: label, ms: Math.round(durationMs) });
  if (!quiet) console.log(`${label}: ${(durationMs / 1000).toFixed(2)}s`);
  return result;
}
