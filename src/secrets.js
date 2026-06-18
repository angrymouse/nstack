import { spawnSync } from "node:child_process";
import path from "node:path";
import { stdin } from "node:process";
import {
  localEnvPath,
  localEnvPathForTarget,
  normalizeTarget,
  secretsEnvPathForTarget,
  targetFromOptions,
} from "./config.js";
import { syncEnvironment } from "./deploy.js";
import { pull } from "./pull.js";
import { Prompter } from "./prompt.js";
import { ensureDir, formatDotEnv, parseDotEnv, readText, writeText } from "./util.js";

export async function runSecretCommand(args, options = {}) {
  const [command = "list", name, ...rest] = args;
  if (command === "list" || command === "ls") return listSecrets(options);
  if (command === "set" || command === "add" || command === "put") return setSecret(name, rest.join(" "), options);
  if (command === "unset" || command === "remove" || command === "rm" || command === "delete") return unsetSecret(name, options);
  if (command === "pull" || command === "sync") return pull(options);
  if (command === "push" || command === "apply") return syncEnvironment(options);
  if (command === "run" || command === "exec") return runWithEnv([name, ...rest], options);
  throw new Error(`Unknown env command: ${command}. Use list, set, unset, pull, push, or run.`);
}

function listSecrets(options) {
  const cwd = options.cwd || process.cwd();
  const target = secretTarget(cwd, options);
  const values = readSecrets(cwd, target);
  const names = Object.keys(values).sort();
  const report = {
    target,
    file: secretsEnvPathForTarget(target),
    count: names.length,
    keys: names,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  if (names.length === 0) {
    console.log("No app runtime secrets set.");
    return report;
  }
  for (const name of names) {
    console.log(`${name}=********`);
  }
  return report;
}

async function setSecret(name, value, options) {
  const key = validateSecretName(name);
  const cwd = options.cwd || process.cwd();
  const target = secretTarget(cwd, options);
  const prompter = new Prompter({ yes: options.yes });
  try {
    const hasDirectValue = Boolean(value || process.env[key]);
    const stdinValue = hasDirectValue ? "" : await readPipedStdin();
    const nextValue = value || process.env[key] || stdinValue || await prompter.ask(key, `Secret ${key}`, { secret: true });
    const current = readSecrets(cwd, target);
    const existed = Object.hasOwn(current, key);
    const values = { ...current, [key]: nextValue };
    writeSecrets(cwd, target, values);
    const report = secretMutationReport("set", target, key, values, { existed });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    console.log(`Set app runtime secret ${key}`);
    return report;
  } finally {
    prompter.close();
  }
}

function unsetSecret(name, options) {
  const key = validateSecretName(name);
  const cwd = options.cwd || process.cwd();
  const target = secretTarget(cwd, options);
  const values = readSecrets(cwd, target);
  const existed = Object.hasOwn(values, key);
  delete values[key];
  writeSecrets(cwd, target, values);
  const report = secretMutationReport("unset", target, key, values, { existed });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(`Unset app runtime secret ${key}`);
  return report;
}

function secretMutationReport(action, target, key, values, details = {}) {
  const keys = Object.keys(values).sort();
  return {
    action,
    target,
    file: secretsEnvPathForTarget(target),
    key,
    existed: Boolean(details.existed),
    count: keys.length,
    keys,
  };
}

function runWithEnv(rawArgs, options) {
  const commandArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const [command, ...args] = commandArgs;
  if (!command) throw new Error("Command is required. Use `nstack env run -- <command>`.");
  const cwd = options.cwd || process.cwd();
  const target = secretTarget(cwd, options);
  const env = {
    ...readLocalEnv(cwd, target),
    ...readSecrets(cwd, target),
    ...process.env,
  };
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} exited from signal ${result.signal}`);
  if (result.status && result.status !== 0) process.exitCode = result.status;
}

function validateSecretName(name) {
  if (!name) throw new Error("Secret name is required.");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid secret name: ${name}`);
  }
  return name;
}

function readLocalEnv(cwd, target) {
  const values = target === "prod"
    ? parseDotEnv(readText(path.join(cwd, localEnvPath), ""))
    : parseDotEnv(readText(path.join(cwd, localEnvPathForTarget(target)), ""));
  if (target !== "prod") values.NSTACK_TARGET = target;
  return values;
}

function readSecrets(cwd = process.cwd(), target = "prod") {
  return parseDotEnv(readText(path.join(cwd, secretsEnvPathForTarget(target)), ""));
}

function writeSecrets(cwd = process.cwd(), target = "prod", values) {
  const file = path.join(cwd, secretsEnvPathForTarget(target));
  ensureDir(path.dirname(file));
  writeText(file, formatDotEnv(values));
}

function secretTarget(cwd, options = {}) {
  const explicit = targetFromOptions(options);
  if (explicit) return normalizeTarget(explicit);
  const local = parseDotEnv(readText(path.join(cwd, localEnvPath), ""));
  return normalizeTarget(process.env.NSTACK_TARGET || local.NSTACK_TARGET || "prod");
}

async function readPipedStdin() {
  if (stdin.isTTY) return "";
  let value = "";
  for await (const chunk of stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}
