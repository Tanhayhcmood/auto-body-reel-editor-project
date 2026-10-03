import assert from "node:assert/strict";
import test from "node:test";
import { createAIProvider, GeminiAPIError, GeminiProvider } from "./provider";

test("selects the configured Gemini provider and model", () => {
  const provider = createAIProvider({
    AI_PROVIDER: "gemini",
    GEMINI_MODEL: "gemini-3.8-flash",
  });

  assert.ok(provider instanceof GeminiProvider);
  assert.equal(provider.name, "gemini");
  assert.equal(provider.model, "gemini-3.8-flash");
});

test("defaults to the current stable Gemini Flash model", () => {
  const provider = createAIProvider({ AI_PROVIDER: "gemini" });
  assert.equal(provider.model, "gemini-3.8-flash");
});

test("keeps a sanitized upstream reason for Gemini API failures", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: unknown) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        error: {
          message:
            "This model is unavailable for API key AIza1234567890123456789012345.",
        },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const provider = new GeminiProvider("gemini-3.8-flash", () => "test-key");
    await assert.rejects(
      provider.generateText("test prompt"),
      (error: unknown) =>
        error instanceof GeminiAPIError &&
        error.message === "Gemini API request failed with status 404." &&
        error.upstreamMessage ===
          "This model is unavailable for API key [REDACTED_API_KEY].",
    );
    assert.equal(
      requestedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unsupported provider instead of silently switching", () => {
  assert.throws(
    () => createAIProvider({ AI_PROVIDER: "unknown" }),
    /Unsupported AI_PROVIDER/,
  );
});