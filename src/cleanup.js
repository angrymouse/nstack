import { performance } from "node:perf_hooks";
import { loadConfig, loadState, targetFromOptions } from "./config.js";
import { DokployProvider } from "./providers/dokploy.js";

export async function cleanup(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = await loadConfig(cwd, { target: targetFromOptions(options) });
  const state = loadState(cwd, config.deploy.target);
  if (config.deploy.provider.type !== "dokploy") {
    throw new Error("nstack cleanup currently supports Dokploy targets only.");
  }
  if (!config.deploy.provider.url || !config.deploy.provider.apiKey) {
    throw new Error("Dokploy URL and API key are required. Run `nstack configure --dokploy-url <url> --dokploy-api-key <key>`.");
  }

  const provider = new DokployProvider({ config, state });
  const timings = [];
  await timed("dokploy: enable docker cleanup", timings, () => provider.enableDockerCleanup());
  await timed("dokploy: prune unused images", timings, () => provider.cleanUnusedImages());

  const report = {
    app: {
      name: config.app.name,
      slug: config.app.slug,
    },
    deploy: {
      target: config.deploy.target,
      provider: config.deploy.provider.type,
      project: config.deploy.provider.projectName,
      environment: config.deploy.provider.environmentName,
      serverId: config.deploy.provider.serverId || null,
    },
    cleanup: {
      dockerCleanupEnabled: true,
      unusedImagesPruned: true,
    },
    timings: summarizeTimings(timings),
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Cleanup complete for ${config.app.slug}`);
    console.log(`  docker cleanup: enabled`);
    console.log(`  unused images: pruned`);
    console.log(`  time: ${(report.timings.total_ms / 1000).toFixed(2)}s`);
  }
  return report;
}

async function timed(name, timings, task) {
  const startedAt = performance.now();
  const result = await task();
  const ms = Math.round(performance.now() - startedAt);
  timings.push({ name, ms, seconds: Number((ms / 1000).toFixed(3)) });
  return result;
}

function summarizeTimings(timings) {
  return {
    total_ms: timings.reduce((sum, entry) => sum + entry.ms, 0),
    steps: timings,
  };
}
