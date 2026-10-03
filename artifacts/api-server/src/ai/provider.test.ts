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

test("sends compressed audio to Gemini as an inline audio part", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new GeminiProvider("gemini-3.8-flash", () => "test-key", {
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await provider.generateMultimodal("Transcribe this audio.", [
    {
      label: "Source audio",
      mimeType: "audio/mp3",
      data: Uint8Array.from([1, 2, 3]),
    },
  ]);

  assert.equal(result, '{"segments":[]}');
  const contents = requestBody?.["contents"] as Array<{
    parts: Array<Record<string, unknown>>;
  }>;
  const audioPart = contents[0]?.parts[2]?.["inline_data"] as {
    mime_type: string;
    data: string;
  };
  assert.equal(audioPart.mime_type, "audio/mp3");
  assert.equal(audioPart.data, "AQID");
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

test("retries temporary Gemini overloads and succeeds", async () => {
  let requestCount = 0;
  const retryDelays: number[] = [];
  const provider = new GeminiProvider("gemini-3.8-flash", () => "test-key", {
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Temporary model overload." } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  });

  assert.equal(await provider.generateText("test prompt"), "recovered");
  assert.equal(requestCount, 2);
  assert.deepEqual(retryDelays, [1_000]);
});

test("stops after three attempts when Gemini remains unavailable", async () => {
  let requestCount = 0;
  const retryDelays: number[] = [];
  const provider = new GeminiProvider("gemini-3.8-flash", () => "test-key", {
    fetcher: async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({ error: { message: "Still overloaded." } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    },
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
  });

  await assert.rejects(
    provider.generateText("test prompt"),
    (error: unknown) =>
      error instanceof GeminiAPIError &&
      error.message === "Gemini API request failed with status 503." &&
      error.upstreamMessage === "Still overloaded.",
  );
  assert.equal(requestCount, 3);
  assert.deepEqual(retryDelays, [1_000, 2_000]);
});

