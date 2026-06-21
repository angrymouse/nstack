#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  aiDevServerAllowed,
  detectAgentHarness,
  devServerGuardMessage,
  ensureLocalReady,
  root,
  shell,
} from "./nstack-local.mjs";

const children = [];

let stopping = false;

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();

async function start() {
  enforceHarnessGuard();
  await ensureLocalReady();
  spawnManaged("backend", "pnpm", ["--dir", "backend", "dev"]);

  const initial = spawnSync(process.execPath, ["scripts/nstack-client.mjs", "gen"], {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (initial.status !== 0) {
    stopping = true;
    stopChildren();
    process.exit(initial.status || 1);
  }

  spawnManaged("client", process.execPath, ["scripts/nstack-client.mjs", "watch"]);
  spawnManaged("frontend", "pnpm", ["--dir", "frontend", "dev"]);
}

function enforceHarnessGuard() {
  const harness = detectAgentHarness();
  if (!harness.detected || aiDevServerAllowed()) return;
  console.error(devServerGuardMessage(harness));
  process.exit(1);
}

function spawnManaged(name, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell });
  child.__nstackName = name;
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    stopChildren();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
  return child;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  stopChildren(signal);
}

function stopChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}
