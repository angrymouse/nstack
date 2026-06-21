#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.env.NSTACK_BENCH_DIR || "/tmp/nstack-bench-heavy";
const depMb = Number(process.env.NSTACK_BENCH_DEP_MB || 1024);
const realDocker = process.env.NSTACK_BENCH_REAL_DOCKER !== "0";
const envBase = { ...process.env };

const rows = [];

function main() {
  const node = process.execPath;
  rmSync(appDir, { recursive: true, force: true });

  measure("init generated app", () => run(node, [
    join(repo, "bin/nstack.js"),
    "init",
    appDir,
    "--force",
    "--yes",
    "--domain",
    "bench.example.test",
    "--build-mode",
    "compose",
  ]));

  measure("expand app surface", () => expandFixture());
  measure("pnpm install", () => run("pnpm", ["install"], { cwd: appDir }));
  measure(`inflate node_modules ${depMb} MiB`, () => inflateNodeModules(depMb));
  createDockerWrappers();

  const render = measure("nstack render --json", () => run(node, [
    join(repo, "bin/nstack.js"),
    "--cwd",
    appDir,
    "render",
    "--json",
  ]));

  measure("nstack doctor --json", () => run(node, [
    join(repo, "bin/nstack.js"),
    "--cwd",
    appDir,
    "doctor",
    "--json",
  ]));

  const stubbedBuild = measure("nstack build, docker stub", () => run(node, [
    join(repo, "bin/nstack.js"),
    "--cwd",
    appDir,
    "build",
    "--yes",
    "--json",
  ], { env: withPath(join(appDir, "fakebin")) }));

  measure("frontend pnpm build", () => run("pnpm", ["--dir", "frontend", "build"], { cwd: appDir }));
  measure("app pnpm check", () => run("pnpm", ["check"], { cwd: appDir }));

  let realBuild = null;
  let realSourceBuild = null;
  let realDependencyBuild = null;
  if (realDocker) {
    realBuild = measure("nstack build, real docker/no push", () => run(node, [
      join(repo, "bin/nstack.js"),
      "--cwd",
      appDir,
      "build",
      "--yes",
      "--json",
    ], { env: withPath(join(appDir, "realbuildbin")) }));

    mutateFrontendSource("source touch");
    realSourceBuild = measure("nstack build, real docker/source touch", () => run(node, [
      join(repo, "bin/nstack.js"),
      "--cwd",
      appDir,
      "build",
      "--yes",
      "--json",
    ], { env: withPath(join(appDir, "realbuildbin")) }));

    measure("frontend dependency lockfile touch", () => touchFrontendDependency());
    realDependencyBuild = measure("nstack build, real docker/dependency touch", () => run(node, [
      join(repo, "bin/nstack.js"),
      "--cwd",
      appDir,
      "build",
      "--yes",
      "--json",
    ], { env: withPath(join(appDir, "realbuildbin")) }));
  }

  const sizes = {
    app: du(appDir),
    app_apparent_mib: du(appDir, ["-sm", "--apparent-size"]),
    app_disk_mib: du(appDir, ["-sm"]),
    root_node_modules_apparent_mib: du(join(appDir, "node_modules"), ["-sm", "--apparent-size"]),
    frontend_node_modules_apparent_mib: du(join(appDir, "frontend", "node_modules"), ["-sm", "--apparent-size"]),
    backend_node_modules_apparent_mib: du(join(appDir, "backend", "node_modules"), ["-sm", "--apparent-size"]),
  };

  console.log(JSON.stringify({
    fixture: {
      dir: appDir,
      dependencyPressureMiB: depMb,
      sizes,
      resourcesSource: parseJson(render.stdout)?.resources?.source || null,
    },
    timings: rows,
    buildPhases: {
      stubbed: buildPhases(stubbedBuild.stdout),
      realDockerNoPush: realBuild ? buildPhases(realBuild.stdout) : null,
      realDockerSourceTouch: realSourceBuild ? buildPhases(realSourceBuild.stdout) : null,
      realDockerDependencyTouch: realDependencyBuild ? buildPhases(realDependencyBuild.stdout) : null,
    },
    slowest: rows.slice().sort((a, b) => b.ms - a.ms).slice(0, 8),
  }, null, 2));
}

function mutateFrontendSource(label) {
  const file = join(appDir, "frontend", "app", "pages", "index.vue");
  const source = readFileSync(file, "utf8");
  writeFileSync(file, source.replace(/nstack bench[^"]*/, `nstack bench ${label}`));
}

function touchFrontendDependency() {
  addDependencies(join(appDir, "frontend", "package.json"), {
    destr: "2.0.5",
  });
  run("pnpm", ["install", "--lockfile-only"], { cwd: appDir });
}

function expandFixture() {
  addDependencies(join(appDir, "frontend", "package.json"), {
    "@tanstack/vue-query": "latest",
    "@vueuse/core": "latest",
    "chart.js": "latest",
    "date-fns": "latest",
    "echarts": "latest",
    "lodash-es": "latest",
    "three": "latest",
    "zod": "latest",
  });
  addDependencies(join(appDir, "backend", "package.json"), {
    "@aws-sdk/client-s3": "latest",
    "decimal.js": "latest",
    "uuid": "latest",
    "zod": "latest",
  });

  mkdirSync(join(appDir, "backend", "api"), { recursive: true });
  for (let i = 0; i < 36; i += 1) {
    const id = String(i).padStart(2, "0");
    writeFileSync(join(appDir, "backend", "api", `bench-${id}.ts`), `import { api } from "encore.dev/api";
import { S3Client } from "@aws-sdk/client-s3";
import Decimal from "decimal.js";
import { v4 as uuid } from "uuid";
import { z } from "zod";

const schema = z.object({ ok: z.boolean(), id: z.number(), token: z.string() });
const client = new S3Client({ region: "us-east-1" });

export const bench${id} = api({ expose: true, method: "GET", path: "/bench/${id}" }, async () => {
  const value = new Decimal(${i + 1}).mul(42).toNumber();
  return schema.parse({ ok: Boolean(client), id: value, token: uuid() });
});
`);
  }

  const cards = Array.from({ length: 80 }, (_, i) => `<li>{{ metrics[${i % 16}].label }} {{ metrics[${i % 16}].value }}</li>`).join("\n      ");
  writeFileSync(join(appDir, "frontend", "app", "pages", "index.vue"), `<script setup lang="ts">
import { QueryClient } from "@tanstack/vue-query";
import { useStorage } from "@vueuse/core";
import { formatDistanceToNow } from "date-fns";
import * as echarts from "echarts/core";
import { uniq } from "lodash-es";
import * as THREE from "three";
import { z } from "zod";

const schema = z.object({ app: z.string(), uptime_seconds: z.number() }).passthrough();
const { data } = await useAsyncData("status", async () => schema.parse(await apiClient().api.status()));
const saved = useStorage("nstack-bench-filter", "all");
const queryClient = new QueryClient();
const vector = new THREE.Vector3(1, 2, 3);
const metrics = computed(() => uniq(Array.from({ length: 16 }, (_, index) => ({
  label: \`metric-\${index}\`,
  value: Math.round(vector.length() * (index + 1) + Object.keys(echarts).length + queryClient.isFetching()),
}))));
const updated = computed(() => formatDistanceToNow(Date.now() - Number(data.value?.uptime_seconds || 0) * 1000));
</script>

<template>
  <main>
    <h1>{{ data?.app || "nstack bench" }}</h1>
    <p>{{ updated }}</p>
    <ul>
      ${cards}
    </ul>
  </main>
</template>
`);
}

function addDependencies(file, deps) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.dependencies = { ...(pkg.dependencies || {}), ...deps };
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

function inflateNodeModules(totalMb) {
  const frontendMb = Math.floor(totalMb * 0.75);
  const backendMb = totalMb - frontendMb;
  writePayload(join(appDir, "frontend", "node_modules", "@nstack", "bench-heavy"), frontendMb);
  writePayload(join(appDir, "backend", "node_modules", "@nstack", "bench-heavy"), backendMb);
}

function writePayload(dir, mb) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "@nstack/bench-heavy", version: "0.0.0" })}\n`);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < mb; i += 1) {
    chunk.fill((i % 251) + 1);
    writeFileSync(join(dir, `payload-${String(i).padStart(4, "0")}.bin`), chunk);
  }
}

function createDockerWrappers() {
  const fakeBin = join(appDir, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "docker"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("Docker version benchmark-stub");
process.exit(0);
`);
  chmodSync(join(fakeBin, "docker"), 0o755);

  const realBin = join(appDir, "realbuildbin");
  mkdirSync(realBin, { recursive: true });
  writeFileSync(join(realBin, "docker"), `#!/usr/bin/env bash
if [ "$1" = "push" ]; then
  printf 'stubbed docker push %s\\n' "$2"
  exit 0
fi
exec /usr/bin/docker "$@"
`);
  chmodSync(join(realBin, "docker"), 0o755);
}

function measure(label, task) {
  const startedAt = performance.now();
  const result = task();
  const ms = Math.round(performance.now() - startedAt);
  rows.push({ label, ms, seconds: Number((ms / 1000).toFixed(3)) });
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: options.env || envBase,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function withPath(prefix) {
  return { ...envBase, DOCKER_BUILDKIT: envBase.DOCKER_BUILDKIT || "1", PATH: `${prefix}:${envBase.PATH || ""}` };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildPhases(text) {
  const parsed = parseJson(text);
  return parsed?.timings?.steps?.slice().sort((a, b) => b.ms - a.ms) || [];
}

function du(target, args = ["-sh"]) {
  if (!existsSync(target)) return "";
  const result = spawnSync("du", [...args, target], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\s+/)[0] : "";
}

main();
