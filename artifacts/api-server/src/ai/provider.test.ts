import assert from "node:assert/strict";
import test from "node:test";
import { createAIProvider, GeminiProvider } from "./provider";

test("selects the configured Gemini provider and model", () => {
  const provider = createAIProvider({
    AI_PROVIDER: "gemini",
    GEMINI_MODEL: "gemini-2.5-flash",
  });

  assert.ok(provider instanceof GeminiProvider);
  assert.equal(provider.name, "gemini");
  assert.equal(provider.model, "gemini-2.5-flash");
});

test("rejects an unsupported provider instead of silently switching", () => {
  assert.throws(
    () => createAIProvider({ AI_PROVIDER: "unknown" }),
    /Unsupported AI_PROVIDER/,
  );
});