import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCronRunnerSource, parseMetadataJson } from "../src/cron-runner.js";

test("cron runner source maps Encore cron metadata to the generated handler import", () => {
  const source = buildCronRunnerSource({
    meta: {
      svcs: [
        {
          name: "api",
          rel_path: "api",
          rpcs: [{ name: "hourlyTick" }],
        },
      ],
      cron_jobs: [
        {
          id: "demo-hourly",
          endpoint: { pkg: "api", name: "hourlyTick" },
        },
      ],
    },
    entrypointSource: `
import { hourlyTick as api_hourlyTickImpl0 } from "../../../../api/cron";

const handlers = [
  {
    apiRoute: {
      service: "api",
      name: "hourlyTick",
      path: { segments: [] },
      handler: api_hourlyTickImpl0,
    },
    endpointOptions: {"expose":false},
  },
];
`,
  });

  assert.match(source, /import \{ hourlyTick as nstackCron0 \} from "\.\.\/\.\.\/\.\.\/\.\.\/api\/cron";/);
  assert.match(source, /\["demo-hourly", nstackCron0\]/);
  assert.match(source, /NSTACK_CRON_DRAIN_MS/);
  assert.doesNotMatch(source, /fetch\(/);
});

test("cron runner source is omitted when metadata has no cron jobs", () => {
  const source = buildCronRunnerSource({
    meta: { svcs: [], cron_jobs: [] },
    entrypointSource: "",
  });

  assert.equal(source, "");
});

test("metadata parser tolerates log lines around Encore JSON output", () => {
  assert.deepEqual(parseMetadataJson("\u001b[32mready\u001b[0m\n{\"cron_jobs\":[]}\n"), { cron_jobs: [] });
});
