const disabledValues = new Set(["0", "false", "off", "no", "none", ""]);

const harnessChecks = [
  {
    name: "codex",
    label: "Codex",
    markers: ["CODEX_CI", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_PACKAGE_ROOT"],
  },
  {
    name: "claude-code",
    label: "Claude Code",
    markers: ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"],
  },
  {
    name: "paseo",
    label: "Paseo",
    markers: ["PASEO_AGENT_ID"],
  },
  {
    name: "opencode",
    label: "OpenCode",
    markers: ["OPENCODE", "OPENCODE_SESSION_ID"],
  },
  {
    name: "cursor",
    label: "Cursor",
    markers: ["CURSOR_AGENT", "CURSOR_TRACE_ID"],
  },
  {
    name: "windsurf",
    label: "Windsurf",
    markers: ["WINDSURF", "WINDSURF_SESSION_ID"],
  },
];

export function detectAgentHarness(env = process.env) {
  const override = String(env.NSTACK_AGENT_HARNESS || "").trim();
  if (override) {
    const normalized = override.toLowerCase();
    if (disabledValues.has(normalized)) return noHarness();
    return {
      detected: true,
      name: slugHarnessName(override),
      label: labelHarnessName(override),
      markers: ["NSTACK_AGENT_HARNESS"],
    };
  }

  for (const check of harnessChecks) {
    const markers = check.markers.filter((marker) => Boolean(env[marker]));
    if (markers.length > 0) {
      return {
        detected: true,
        name: check.name,
        label: check.label,
        markers,
      };
    }
  }

  return noHarness();
}

export function agentHarnessNotice(harness = detectAgentHarness()) {
  if (!harness.detected) return "";
  return [
    `nstack dev detected ${harness.label}.`,
    "This command starts long-running dev servers; agents should run it in a managed background terminal, or use `pnpm check` for one-shot validation.",
  ].join(" ");
}

function noHarness() {
  return {
    detected: false,
    name: null,
    label: null,
    markers: [],
  };
}

function slugHarnessName(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "agent";
}

function labelHarnessName(value) {
  return String(value || "agent")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "agent";
}
