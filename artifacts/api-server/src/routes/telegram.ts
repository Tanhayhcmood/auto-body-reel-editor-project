import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router, type IRouter, type Request, type RequestHandler } from "express";
import { logger } from "../lib/logger";
import {
  analyzeUploadedVideo,
  type VideoAnalysisResult,
} from "../videos/video-analysis";
import { getVideoUploadDirectory } from "../videos/storage";
import {
  NoSuitableAutoReelSegmentsError,
  renderAutoBodyReel,
  type AutoReelPlan,
} from "../videos/reel-editor";

const TELEGRAM_API_URL = "https://api.telegram.org";
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20_000_000;
const TELEGRAM_FILE_TOO_LARGE_ERROR = "Telegram video exceeds the download limit.";
const TELEGRAM_FILE_TOO_LARGE_REPLY =
  "حجم ویدئو از سقف دانلود تلگرام (۲۰ مگابایت) بیشتر است. لطفاً ویدئوی کم‌حجم‌تری بفرستید.";
const TELEGRAM_REEL_TOO_LARGE_ERROR = "Edited reel exceeds Telegram upload limit.";
const TELEGRAM_REEL_TOO_LARGE_REPLY =
  "ریل ساخته شد، اما حجم فایل از سقف ارسال ۲۰ مگابایت بیشتر است.";
const MAX_TELEGRAM_MESSAGE_LENGTH = 3_800;
const MAX_RECENT_UPDATES = 5_000;

export interface TelegramMedia {
  fileId: string;
  fileSize?: number;
  mimeType?: string;
  fileName?: string;
}

export interface TelegramMessage {
  chatId?: number;
  text?: string;
  fromIsBot?: boolean;
  video?: TelegramMedia;
  videoNote?: TelegramMedia;
  document?: TelegramMedia;
}

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramMessage;
}

type VideoAnalyzer = (
  videoId: string,
  videoPath: string,
) => Promise<VideoAnalysisResult>;

export interface TelegramProcessingOptions {
  fetcher?: typeof fetch;
  uploadDirectory?: string;
  analyze?: VideoAnalyzer;
  renderReel?: (inputPath: string, outputPath: string, result: VideoAnalysisResult) => Promise<AutoReelPlan>;
}

export interface TelegramWebhookOptions extends TelegramProcessingOptions {
  botToken?: string;
  webhookSecret?: string;
  processUpdate?: (update: TelegramUpdate, token: string) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseMedia(value: unknown): TelegramMedia | undefined {
  const media = asRecord(value);
  if (!media) {
    return undefined;
  }
  const fileId = media?.["file_id"];
  if (typeof fileId !== "string" || fileId.length === 0) {
    return undefined;
  }

  const fileSize = media["file_size"];
  return {
    fileId,
    ...(typeof fileSize === "number" &&
    Number.isSafeInteger(fileSize) &&
    fileSize >= 0
      ? { fileSize }
      : {}),
    ...(typeof media["mime_type"] === "string"
      ? { mimeType: media["mime_type"] }
      : {}),
    ...(typeof media["file_name"] === "string"
      ? { fileName: media["file_name"] }
      : {}),
  };
}

function parseUpdate(value: unknown): TelegramUpdate | undefined {
  const update = asRecord(value);
  if (!update) {
    return undefined;
  }
  const updateId = update["update_id"];
  if (
    typeof updateId !== "number" ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0
  ) {
    return undefined;
  }

  const rawMessage = asRecord(update["message"]);
  if (!rawMessage) {
    return { updateId };
  }

  const chat = asRecord(rawMessage["chat"]);
  const chatId = chat?.["id"];
  const from = asRecord(rawMessage["from"]);
  return {
    updateId,
    message: {
      ...(typeof chatId === "number" && Number.isSafeInteger(chatId)
        ? { chatId }
        : {}),
      ...(typeof rawMessage["text"] === "string"
        ? { text: rawMessage["text"] }
        : {}),
      ...(from?.["is_bot"] === true ? { fromIsBot: true } : {}),
      ...(parseMedia(rawMessage["video"])
        ? { video: parseMedia(rawMessage["video"]) }
        : {}),
      ...(parseMedia(rawMessage["video_note"])
        ? { videoNote: parseMedia(rawMessage["video_note"]) }
        : {}),
      ...(parseMedia(rawMessage["document"])
        ? { document: parseMedia(rawMessage["document"]) }
        : {}),
    },
  };
}

function secretsMatch(expected: string, provided: string | undefined): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided ?? "", "utf8");
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function redactLogText(message: string): string {
  return message
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 300);
}

function safeErrorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
  upstreamMessage?: string;
} {
  const errorName =
    error instanceof Error && error.name ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const upstreamMessage =
    error instanceof Error &&
    "upstreamMessage" in error &&
    typeof error.upstreamMessage === "string"
      ? redactLogText(error.upstreamMessage)
      : undefined;
  return {
    errorName: errorName.slice(0, 80),
    errorMessage: redactLogText(rawMessage),
    ...(upstreamMessage ? { upstreamMessage } : {}),
  };
}

function logTelegramProcessingError(
  updateId: number,
  stage: string,
  error: unknown,
  message: string,
): void {
  logger.error(
    { updateId, stage, ...safeErrorDetails(error) },
    message,
  );
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${TELEGRAM_API_URL}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned an invalid response.`);
  }

  const envelope = asRecord(payload);
  if (!response.ok || envelope?.["ok"] !== true) {
    throw new Error(`Telegram ${method} request was rejected.`);
  }
  return envelope["result"] as T;
}

async function downloadTelegramFile(
  token: string,
  filePath: string,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const pathParts = filePath.split("/");
  if (
    pathParts.length === 0 ||
    pathParts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9_.-]+$/.test(part),
    )
  ) {
    throw new Error("Telegram returned an invalid file path.");
  }

  let response: Response;
  try {
    const encodedPath = pathParts.map(encodeURIComponent).join("/");
    response = await fetcher(
      `${TELEGRAM_API_URL}/file/bot${token}/${encodedPath}`,
      { signal: AbortSignal.timeout(45_000) },
    );
  } catch {
    throw new Error("Telegram video download failed.");
  }
  if (!response.ok) {
    throw new Error("Telegram video download failed.");
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > MAX_TELEGRAM_DOWNLOAD_BYTES
  ) {
    throw new Error("Telegram video exceeds the download limit.");
  }

  const fileData = await response.arrayBuffer();
  if (fileData.byteLength === 0) {
    throw new Error("Telegram returned an empty video.");
  }
  if (fileData.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES) {
    throw new Error("Telegram video exceeds the download limit.");
  }
  return Buffer.from(fileData);
}

async function sendMessage(
  chatId: number,
  text: string,
  token: string,
  fetcher: typeof fetch,
): Promise<void> {
  await callTelegramApi<unknown>(
    token,
    "sendMessage",
    { chat_id: chatId, text },
    fetcher,
  );
}


async function sendTelegramVideo(chatId: number, videoPath: string, caption: string, token: string, fetcher: typeof fetch): Promise<void> {
  const videoBytes = new Uint8Array(await readFile(videoPath));
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("caption", caption);
  body.set("supports_streaming", "true");
  body.set("video", new Blob([videoBytes.buffer], { type: "video/mp4" }), "auto-body-reel.mp4");

  let response: Response;
  try {
    response = await fetcher(TELEGRAM_API_URL + "/bot" + token + "/sendVideo", {
      method: "POST", body, signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("Telegram sendVideo request failed.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Telegram sendVideo returned an invalid response.");
  }
  const envelope = asRecord(payload);
  if (!response.ok || envelope?.["ok"] !== true) throw new Error("Telegram sendVideo request was rejected.");
}

function formatTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatVideoAnalysisMessages(
  result: VideoAnalysisResult,
): string[] {
  const header = [
    "تحلیل ویدئو کامل شد.",
    `مدت: ${formatTime(result.duration_seconds)} | ابعاد: ${result.width}×${result.height}`,
    `تعداد بخش‌ها: ${result.segments.length}`,
  ].join("\n");
  const chunks: string[] = [];
  let current = header;

  result.segments.forEach((segment, index) => {
    const labels = segment.labels.slice(0, 6);
    const detail = [
      `بخش ${index + 1} (${formatTime(segment.start)} تا ${formatTime(segment.end)})`,
      truncate(segment.summary, 220),
      ...(labels.length > 0 ? [`برچسب‌ها: ${labels.join("، ")}`] : []),
      `ارتباط با تعمیر: ${Math.round(segment.repair_relevance * 100)}٪`,
    ].join("\n");
    const next = `${current}\n\n${detail}`;
    if (next.length > MAX_TELEGRAM_MESSAGE_LENGTH && current !== header) {
      chunks.push(current);
      current = `ادامهٔ تحلیل:\n\n${detail}`;
    } else {
      current = next;
    }
  });

  chunks.push(current);
  return chunks;
}


function getProcessingFailureReply(error: unknown, stage: string): string {
  if (error instanceof Error && error.message === TELEGRAM_FILE_TOO_LARGE_ERROR) return TELEGRAM_FILE_TOO_LARGE_REPLY;
  if (error instanceof Error && error.message === TELEGRAM_REEL_TOO_LARGE_ERROR) return TELEGRAM_REEL_TOO_LARGE_REPLY;
  if (error instanceof NoSuitableAutoReelSegmentsError) return "تحلیل انجام شد، اما بخش مناسب برای ساخت ریل خودکار پیدا نشد.";
  if (stage === "render_reel") return "تحلیل کامل شد، اما تدوین ریل نهایی انجام نشد. گزارش تحلیل بالاتر است.";
  if (stage === "send_reel") return "تحلیل و تدوین کامل شد، اما ارسال ویدئوی نهایی ناموفق بود.";
  return "تحلیل ویدئو انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.";
}

export async function processTelegramUpdate(
  update: TelegramUpdate,
  token: string,
  options: TelegramProcessingOptions = {},
): Promise<void> {
  const message = update.message;
  if (!message || message.chatId === undefined || message.fromIsBot) {
    return;
  }
  const chatId = message.chatId;

  const fetcher = options.fetcher ?? globalThis.fetch;
  const command = message.text
    ?.trim()
    .split(/\s+/, 1)[0]
    ?.split("@", 1)[0]
    ?.toLowerCase();

  if (command === "/start" || command === "/help") {
    await sendMessage(
      chatId,
      "برای دریافت تحلیل و ریل خودکار، یک ویدئوی تعمیر یا رنگ‌کاری بدنهٔ خودرو بفرستید. سقف دانلود تلگرام ۲۰ مگابایت است.",
      token,
      fetcher,
    );
    return;
  }

  const documentIsVideo =
    message.document?.mimeType?.toLowerCase().startsWith("video/") ||
    /\.(mp4|mov|m4v|webm|mkv)$/i.test(message.document?.fileName ?? "");
  const media =
    message.video ??
    message.videoNote ??
    (documentIsVideo ? message.document : undefined);

  if (!media) {
    await sendMessage(
      chatId,
      "لطفاً یک ویدئو بفرستید یا دستور /help را ببینید.",
      token,
      fetcher,
    );
    return;
  }

  if (
    media.fileSize !== undefined &&
    media.fileSize > MAX_TELEGRAM_DOWNLOAD_BYTES
  ) {
    await sendMessage(chatId, TELEGRAM_FILE_TOO_LARGE_REPLY, token, fetcher);
    return;
  }

  await sendMessage(
    chatId,
    "ویدئو دریافت شد؛ در حال تحلیل و آماده‌سازی ریل هستم.",
    token,
    fetcher,
  );

  let videoPath: string | undefined;
  let reelPath: string | undefined;
  let stage = "get_telegram_file";
  try {
    const file = await callTelegramApi<{ file_path?: unknown; file_size?: unknown }>(
      token,
      "getFile",
      { file_id: media.fileId },
      fetcher,
    );
    if (typeof file?.file_path !== "string") {
      throw new Error("Telegram did not return a video path.");
    }
    if (
      typeof file.file_size === "number" &&
      file.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES
    ) {
      throw new Error(TELEGRAM_FILE_TOO_LARGE_ERROR);
    }

    stage = "download_telegram_file";
    const contents = await downloadTelegramFile(token, file.file_path, fetcher);
    if (contents.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      throw new Error(TELEGRAM_FILE_TOO_LARGE_ERROR);
    }

    const videoId = randomUUID();
    const uploadDirectory = options.uploadDirectory ?? getVideoUploadDirectory();
    stage = "store_video";
    await mkdir(uploadDirectory, { recursive: true });
    const storedVideoPath = join(uploadDirectory, videoId);
    videoPath = storedVideoPath;
    await writeFile(storedVideoPath, contents, { flag: "wx" });

    stage = "analyze_video";
    const analyze =
      options.analyze ??
      ((id: string, path: string) => analyzeUploadedVideo(id, path));
    const result = await analyze(videoId, storedVideoPath);
    stage = "send_analysis";
    for (const text of formatVideoAnalysisMessages(result)) {
      await sendMessage(chatId, text, token, fetcher);
    }

    stage = "render_reel";
    await sendMessage(chatId, "تحلیل کامل شد؛ در حال تدوین ریل نهایی هستم.", token, fetcher);
    reelPath = join(uploadDirectory, videoId + "-reel.mp4");
    const renderReel = options.renderReel ??
      ((inputPath: string, outputPath: string, analysis: VideoAnalysisResult) =>
        renderAutoBodyReel(inputPath, outputPath, analysis.segments, analysis.has_audio));
    const plan = await renderReel(storedVideoPath, reelPath, result);
    const reelStats = await stat(reelPath);
    if (reelStats.size === 0) throw new Error("The edited reel is empty.");
    if (reelStats.size > MAX_TELEGRAM_DOWNLOAD_BYTES) throw new Error(TELEGRAM_REEL_TOO_LARGE_ERROR);

    stage = "send_reel";
    const caption = "ریل نهایی آماده است؛ بخش‌ها: " + plan.clips.length +
      " | مدت: " + formatTime(plan.durationSeconds);
    await sendTelegramVideo(chatId, reelPath, caption, token, fetcher);
  } catch (error) {
    logTelegramProcessingError(
      update.updateId,
      stage,
      error,
      "Telegram video processing failed",
    );
    const failureReply = getProcessingFailureReply(error, stage);
    try {
      await sendMessage(chatId, failureReply, token, fetcher);
    } catch (notificationError) {
      logTelegramProcessingError(
        update.updateId,
        "send_failure_notice",
        notificationError,
        "Could not notify the user that video processing failed",
      );
    }
  } finally {
    if (reelPath) {
      await unlink(reelPath).catch(() => undefined);
    }
    if (videoPath) {
      await unlink(videoPath).catch(() => undefined);
    }
  }
}

export function createTelegramWebhookHandler(
  options: TelegramWebhookOptions = {},
): RequestHandler {
  const token =
    options.botToken ?? process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const webhookSecret =
    options.webhookSecret ?? process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
  const seenUpdates = new Set<number>();
  const processUpdate =
    options.processUpdate ??
    ((update: TelegramUpdate, botToken: string) =>
      processTelegramUpdate(update, botToken, {
        fetcher: options.fetcher,
        uploadDirectory: options.uploadDirectory,
        analyze: options.analyze,
        renderReel: options.renderReel,
      }));

  return (request: Request, response, _next): void => {
    if (!token || !webhookSecret) {
      response.status(503).json({ error: "Telegram webhook is not configured." });
      return;
    }

    if (
      !secretsMatch(
        webhookSecret,
        request.header("x-telegram-bot-api-secret-token"),
      )
    ) {
      response.status(401).json({ error: "Invalid Telegram webhook secret." });
      return;
    }

    const update = parseUpdate(request.body);
    if (!update) {
      response.status(400).json({ error: "Invalid Telegram update." });
      return;
    }

    if (seenUpdates.has(update.updateId)) {
      response.status(200).end();
      return;
    }
    seenUpdates.add(update.updateId);
    if (seenUpdates.size > MAX_RECENT_UPDATES) {
      const oldestUpdate = seenUpdates.values().next().value as number | undefined;
      if (oldestUpdate !== undefined) {
        seenUpdates.delete(oldestUpdate);
      }
    }

    response.status(200).end();
    void processUpdate(update, token).catch((error: unknown) => {
      logTelegramProcessingError(
        update.updateId,
        "process_update",
        error,
        "Telegram update processing failed",
      );
    });
  };
}

export function createTelegramRouter(
  options: TelegramWebhookOptions = {},
): IRouter {
  const router: IRouter = Router();
  router.post("/telegram/webhook", createTelegramWebhookHandler(options));
  return router;
}

export default createTelegramRouter();