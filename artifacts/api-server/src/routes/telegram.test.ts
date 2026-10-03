import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Request, Response, RequestHandler } from "express";
import {
  createTelegramWebhookHandler,
  formatVideoAnalysisMessages,
  processTelegramUpdate,
  type TelegramUpdate,
} from "./telegram";
import type { VideoAnalysisResult } from "../videos/video-analysis";

interface HandlerResult {
  statusCode?: number;
  body?: unknown;
  ended: boolean;
}

function invokeHandler(
  handler: RequestHandler,
  secret: string | undefined,
  body: unknown,
): HandlerResult {
  const result: HandlerResult = { ended: false };
  const request = {
    body,
    header(name: string) {
      return name.toLowerCase() === "x-telegram-bot-api-secret-token"
        ? secret
        : undefined;
    },
  } as unknown as Request;
  const response = {
    status(statusCode: number) {
      result.statusCode = statusCode;
      return this;
    },
    json(bodyValue: unknown) {
      result.body = bodyValue;
      return this;
    },
    end() {
      result.ended = true;
      return this;
    },
  } as unknown as Response;

  handler(request, response, () => undefined);
  return result;
}

function analysisResult(
  summary = "A technician sands a damaged panel.",
): VideoAnalysisResult {
  return {
    video_id: "47ce0f01-3f19-4f94-a1d2-4dd7c3aa18f2",
    duration_seconds: 12.5,
    width: 1920,
    height: 1080,
    has_audio: false,
    scene_change_seconds: [],
    segments: [
      {
        segment_id: "segment-1",
        start: 0,
        end: 12.5,
        summary,
        visual_events: [],
        labels: ["repair_process", "sanding"],
        quality_score: 0.9,
        interest_score: 0.8,
        repair_relevance: 0.95,
        transformation_value: 0.4,
      },
    ],
    artifacts: { segments_json: "segments.json", analysis_json: "analysis.json" },
  };
}

test("webhook fails closed when credentials are missing", () => {
  const handler = createTelegramWebhookHandler({
    botToken: "",
    webhookSecret: "secret",
    processUpdate: async () => undefined,
  });

  const result = invokeHandler(
    handler,
    "secret",
    { update_id: 1 },
  );

  assert.equal(result.statusCode, 503);
  assert.equal(result.ended, false);
});

test("webhook rejects an incorrect secret without processing the update", () => {
  let processed = false;
  const handler = createTelegramWebhookHandler({
    botToken: "test-token",
    webhookSecret: "expected-secret",
    processUpdate: async () => {
      processed = true;
    },
  });

  const result = invokeHandler(handler, "wrong-secret", { update_id: 1 });

  assert.equal(result.statusCode, 401);
  assert.equal(processed, false);
});

test("webhook acknowledges valid updates and ignores duplicate update IDs", () => {
  const processedUpdates: number[] = [];
  const handler = createTelegramWebhookHandler({
    botToken: "test-token",
    webhookSecret: "expected-secret",
    processUpdate: async (update) => {
      processedUpdates.push(update.updateId);
    },
  });
  const update = { update_id: 42, message: { text: "/start" } };

  const first = invokeHandler(handler, "expected-secret", update);
  const duplicate = invokeHandler(handler, "expected-secret", update);

  assert.equal(first.statusCode, 200);
  assert.equal(first.ended, true);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.ended, true);
  assert.deepEqual(processedUpdates, [42]);
});

test("analysis messages stay within Telegram's message limit", () => {
  const result: VideoAnalysisResult = {
    ...analysisResult(),
    segments: Array.from({ length: 16 }, (_, index) => ({
      ...analysisResult("Visible repair work. ".repeat(80)).segments[0]!,
      segment_id: `segment-${index + 1}`,
      start: index * 3,
      end: (index + 1) * 3,
    })),
  };

  const messages = formatVideoAnalysisMessages(result);

  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 4096));
  assert.match(messages[0] ?? "", /تحلیل ویدئو کامل شد/);
});

test("video updates download, analyze, reply, and remove the temporary upload", async (t) => {
  const uploadDirectory = await mkdtemp(join(tmpdir(), "telegram-video-test-"));
  t.after(async () => rm(uploadDirectory, { recursive: true, force: true }));

  const sentMessages: string[] = [];
  const sentVideos: number[] = [];
  const sentPhotos: number[] = [];
  let analyzerCalled = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: "videos/sample.mp4", file_size: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/file/bottest-token/")) {
      return new Response(Uint8Array.from([0, 1, 2, 3]));
    }
    if (url.endsWith("/sendPhoto")) {
      assert.ok(init?.body instanceof FormData);
      const photo = init.body.get("photo");
      assert.ok(photo instanceof Blob);
      sentPhotos.push(photo.size);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/sendVideo")) {
      assert.ok(init?.body instanceof FormData);
      const video = init.body.get("video");
      assert.ok(video instanceof Blob);
      sentVideos.push(video.size);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/sendMessage")) {
      const requestBody = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(requestBody.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };
  const update: TelegramUpdate = {
    updateId: 3,
    message: {
      chatId: 123,
      video: { fileId: "telegram-file-id", fileSize: 4 },
    },
  };

  await processTelegramUpdate(update, "test-token", {
    fetcher,
    uploadDirectory,
    analyze: async (_videoId, videoPath) => {
      analyzerCalled = true;
      assert.ok(videoPath.startsWith(uploadDirectory));
      return analysisResult();
    },
    renderReel: async (_inputPath, outputPath, result) => {
      assert.ok(result.segments.length > 0);
      await writeFile(outputPath, Buffer.from([1, 2, 3, 4]));
      const coverPath = outputPath.replace(/\.mp4$/i, "-cover.jpg");
      await writeFile(coverPath, Buffer.from([5, 6, 7]));
      return {
        clips: [{ segment_id: "segment-1", start: 0, end: 12.5 }],
        durationSeconds: 12.5,
        hook: "ترمیم بدنه",
        cta: "نتیجه را ببینید",
        instagramCaption: "ترمیم مرحله‌به‌مرحله #بدنه",
        coverPath,
        transcriptSegmentCount: 1,
      };
    },
  });

  assert.equal(analyzerCalled, true);
  assert.ok(sentMessages.some((message) => message.includes("در حال تحلیل")));
  assert.ok(sentMessages.some((message) => message.includes("تحلیل ویدئو کامل شد")));
  assert.ok(sentMessages.some((message) => message.includes("در حال تدوین")));
  assert.ok(sentMessages.some((message) => message.includes("کپشن اینستاگرام")));
  assert.deepEqual(sentPhotos, [3]);
  assert.deepEqual(sentVideos, [4]);
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("rejects files above Telegram's 20 MB download limit before fetching", async () => {
  const sentMessages: string[] = [];
  let requestCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requestCount += 1;
    const url = String(input);
    if (url.endsWith("/sendMessage")) {
      const requestBody = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(requestBody.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };

  await processTelegramUpdate(
    {
      updateId: 4,
      message: {
        chatId: 123,
        video: { fileId: "telegram-file-id", fileSize: 20_000_001 },
      },
    },
    "test-token",
    { fetcher },
  );

  assert.equal(requestCount, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0] ?? "", /۲۰ مگابایت/);
});

test("does not mislabel analysis failures as oversized videos", async (t) => {
  const uploadDirectory = await mkdtemp(join(tmpdir(), "telegram-video-error-test-"));
  t.after(async () => rm(uploadDirectory, { recursive: true, force: true }));

  const sentMessages: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: "videos/sample.mp4", file_size: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/file/bottest-token/")) {
      return new Response(Uint8Array.from([0, 1, 2, 3]));
    }
    if (url.endsWith("/sendMessage")) {
      const requestBody = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(requestBody.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };

  await processTelegramUpdate(
    {
      updateId: 5,
      message: {
        chatId: 123,
        video: { fileId: "telegram-file-id", fileSize: 4 },
      },
    },
    "test-token",
    {
      fetcher,
      uploadDirectory,
      analyze: async () => {
        throw new Error("Gemini API request failed with status 429.");
      },
    },
  );

  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1] ?? "", /کمی بعد دوباره تلاش/);
  assert.doesNotMatch(sentMessages[1] ?? "", /ویدئوی کوتاه‌تری/);
  assert.deepEqual(await readdir(uploadDirectory), []);
});

test("keeps the completed analysis visible when reel rendering fails", async (t) => {
  const uploadDirectory = await mkdtemp(join(tmpdir(), "telegram-reel-error-test-"));
  t.after(async () => rm(uploadDirectory, { recursive: true, force: true }));
  const sentMessages: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "videos/sample.mp4", file_size: 4 } }), { headers: { "content-type": "application/json" } });
    if (url.includes("/file/bot")) return new Response(Uint8Array.from([0, 1, 2, 3]));
    if (url.endsWith("/sendMessage")) {
      const requestBody = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(requestBody.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  };
  await processTelegramUpdate({ updateId: 6, message: { chatId: 123, video: { fileId: "telegram-file-id", fileSize: 4 } } }, "test-token", {
    fetcher, uploadDirectory, analyze: async () => analysisResult(),
    renderReel: async () => { throw new Error("simulated FFmpeg failure"); },
  });
  assert.ok(sentMessages.some((message) => message.includes("تحلیل ویدئو کامل شد")));
  assert.ok(sentMessages.some((message) => message.includes("تدوین ریل نهایی انجام نشد")));
  assert.deepEqual(await readdir(uploadDirectory), []);
});

