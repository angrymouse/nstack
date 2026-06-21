import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHarnessNotice, detectAgentHarness } from "../src/harness.js";

test("detectAgentHarness detects Codex without exposing env values", () => {
  const harness = detectAgentHarness({
    CODEX_CI: "1",
    CODEX_THREAD_ID: "secret-thread-id",
  });

  assert.equal(harness.detected, true);
  assert.equal(harness.name, "codex");
  assert.equal(harness.label, "Codex");
  assert.deepEqual(harness.markers, ["CODEX_CI", "CODEX_THREAD_ID"]);
  assert.doesNotMatch(JSON.stringify(harness), /secret-thread-id/);
});

test("detectAgentHarness detects Claude Code child sessions", () => {
  const harness = detectAgentHarness({
    CLAUDE_CODE_CHILD_SESSION: "1",
  });

  assert.equal(harness.detected, true);
  assert.equal(harness.name, "claude-code");
  assert.equal(harness.label, "Claude Code");
  assert.deepEqual(harness.markers, ["CLAUDE_CODE_CHILD_SESSION"]);
});

test("detectAgentHarness supports explicit override and disable", () => {
  assert.deepEqual(detectAgentHarness({ NSTACK_AGENT_HARNESS: "custom agent" }), {
    detected: true,
    name: "custom-agent",
    label: "custom agent",
    markers: ["NSTACK_AGENT_HARNESS"],
  });

  assert.deepEqual(detectAgentHarness({ NSTACK_AGENT_HARNESS: "0", CODEX_CI: "1" }), {
    detected: false,
    name: null,
    label: null,
    markers: [],
  });
});

test("agentHarnessNotice explains long-running dev behavior", () => {
  const notice = agentHarnessNotice(detectAgentHarness({ CODEX_CI: "1" }));
  assert.match(notice, /Codex/);
  assert.match(notice, /long-running dev servers/);
  assert.match(notice, /pnpm check/);
});
