#!/usr/bin/env node
import { ensureLocalReady, run } from "./nstack-local.mjs";

await ensureLocalReady();

const client = await run("node", ["scripts/nstack-client.mjs", "gen"]);
if (client !== 0) process.exit(client);

const tasks = [
  ["pnpm", ["--dir", "backend", "exec", "encore", "check", ""]],
  ["pnpm", ["--dir", "backend", "exec", "tsc", "--noEmit"]],
  ["pnpm", ["--dir", "frontend", "exec", "nuxi", "prepare"]],
];

const results = await Promise.all(tasks.map(([command, args]) => run(command, args)));
const failed = results.find((code) => code !== 0);
if (failed) process.exit(failed);
