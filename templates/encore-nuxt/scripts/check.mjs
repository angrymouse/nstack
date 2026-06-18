#!/usr/bin/env node
import { spawn } from "node:child_process";

const tasks = [
  ["pnpm", ["--dir", "backend", "exec", "encore", "check", ""]],
  ["pnpm", ["--dir", "backend", "exec", "tsc", "--noEmit"]],
  ["pnpm", ["--dir", "frontend", "exec", "nuxi", "prepare"]],
];

const results = await Promise.all(tasks.map(([command, args]) => run(command, args)));
const failed = results.find((code) => code !== 0);
if (failed) process.exit(failed);

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (code) => resolve(code || 0));
    child.on("error", () => resolve(1));
  });
}
