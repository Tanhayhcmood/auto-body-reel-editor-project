import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
  duration?: unknown;
}

interface ProbeDocument {
  streams?: unknown;
  format?: {
    duration?: unknown;
  };
}

export class InvalidVideoError extends Error {
  constructor(message = "Uploaded file is not a readable video.") {
    super(message);
    this.name = "InvalidVideoError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseFrameRate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const rate = String(value).trim();
  if (!rate || rate === "N/A") {
    return null;
  }

  const [numeratorText, denominatorText] = rate.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }

  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

export function parseFfprobeMetadata(input: unknown): VideoMetadata {
  const document = asRecord(input) as ProbeDocument | undefined;
  const streams = Array.isArray(document?.streams)
    ? (document.streams as ProbeStream[])
    : [];
  const videoStream = streams.find((stream) => stream?.codec_type === "video");

  if (!videoStream) {
    throw new InvalidVideoError();
  }

  const width = positiveNumber(videoStream.width);
  const height = positiveNumber(videoStream.height);
  const duration =
    positiveNumber(document?.format?.duration) ??
    positiveNumber(videoStream.duration);

  if (!width || !height || !duration) {
    throw new InvalidVideoError("Video metadata is incomplete or invalid.");
  }

  const fps =
    parseFrameRate(videoStream.avg_frame_rate) ??
    parseFrameRate(videoStream.r_frame_rate);

  return {
    durationSeconds: duration,
    width,
    height,
    fps,
    hasAudio: streams.some((stream) => stream?.codec_type === "audio"),
  };
}

export async function extractVideoMetadata(
  filePath: string,
): Promise<VideoMetadata> {
  let stdout: string;

  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration",
        "-of",
        "json",
        filePath,
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
    ));
  } catch (error) {
    const code = asRecord(error)?.["code"];
    if (code === "ENOENT") {
      throw new Error("FFprobe is not installed or is unavailable on PATH.");
    }
    throw new InvalidVideoError();
  }

  let probeResult: unknown;
  try {
    probeResult = JSON.parse(stdout) as unknown;
  } catch {
    throw new InvalidVideoError("FFprobe returned invalid video metadata.");
  }

  return parseFfprobeMetadata(probeResult);
}