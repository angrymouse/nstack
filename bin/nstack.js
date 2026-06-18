#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.NSTACK_DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
