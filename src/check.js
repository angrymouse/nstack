import { runClientGenerator } from "./client.js";
import { ensureLocalReady, isNstackApp } from "./setup.js";
import { run } from "./util.js";

export function runCheck(cwd, options = {}) {
  if (!isNstackApp(cwd)) {
    throw new Error("nstack check requires an nstack app root. Run it from an app root or pass --cwd <app>.");
  }
  ensureLocalReady(cwd, {
    install: !(options.skipInstall || options.noInstall),
    tools: !(options.skipTools || options.noTools),
    docker: !options.skipDocker,
    skipTools: options.skipTools,
    noTools: options.noTools,
  });
  runClientGenerator(cwd, "gen", { capture: Boolean(options.capture) });

  run("pnpm", ["--dir", "backend", "exec", "encore", "check", ""], { cwd, capture: Boolean(options.capture) });
  run("pnpm", ["--dir", "backend", "exec", "tsc", "--noEmit"], { cwd, capture: Boolean(options.capture) });
  run("pnpm", ["--dir", "frontend", "exec", "nuxi", "prepare"], { cwd, capture: Boolean(options.capture) });
  return { mode: "cli" };
}
