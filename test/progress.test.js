import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgress } from "../src/progress.js";

test("progress allowOutput mode leaves nested logs on separate lines", async () => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    const progress = createProgress({ enabled: true });
    await progress.step("Verifying deployment", async () => {
      process.stdout.write("Verified https://example.test\n");
      process.stdout.write("Post-deploy status: ok\n");
    }, { allowOutput: true });
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.isTTY = originalIsTTY;
  }

  assert.equal(chunks.join(""), [
    "Verifying deployment...\n",
    "Verified https://example.test\n",
    "Post-deploy status: ok\n",
    "✓ Verifying deployment\n",
  ].join(""));
});
