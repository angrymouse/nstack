import assert from "node:assert/strict";
import { test } from "node:test";
import { Prompter } from "../src/prompt.js";

test("prompter keeps env and yes-mode automation while TTY UI is library-backed", async () => {
  const original = process.env.NSTACK_PROMPT_TEST_SELECT;
  process.env.NSTACK_PROMPT_TEST_SELECT = "two";
  try {
    const prompter = new Prompter({ yes: false });
    const selected = await prompter.select("NSTACK_PROMPT_TEST_SELECT", "Pick one", [
      { label: "One", value: "one" },
      { label: "Two", value: "two" },
    ]);
    assert.equal(selected.value, "two");
  } finally {
    if (original === undefined) delete process.env.NSTACK_PROMPT_TEST_SELECT;
    else process.env.NSTACK_PROMPT_TEST_SELECT = original;
  }

  const prompter = new Prompter({ yes: true });
  assert.equal(await prompter.ask("NSTACK_PROMPT_TEST_REQUIRED", "Required", { defaultValue: "fallback" }), "fallback");
  assert.equal(await prompter.confirm("NSTACK_PROMPT_TEST_CONFIRM", "Confirm?", { defaultValue: false }), false);
  assert.deepEqual(await prompter.select("NSTACK_PROMPT_TEST_DEFAULT", "Pick default", [
    { label: "One", value: "one" },
    { label: "Two", value: "two" },
  ], { defaultIndex: 1 }), { label: "Two", value: "two" });
});
