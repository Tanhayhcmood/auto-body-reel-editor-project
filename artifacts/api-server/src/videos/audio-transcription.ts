import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { AIProvider } from "../ai/provider";

const execFileAsync = promisify(execFile);
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

const TranscriptSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            start: z.number().finite().nonnegative(),
            end: z.number().finite().positive(),
            text: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AudioTranscriptionOptions {
  runFfmpeg?: (inputPath: string, outputPath: string) => Promise<void>;
}

export class InvalidTranscriptError extends Error {
  constructor(message = "Gemini returned an invalid audio transcript.") {
    super(message);
    this.name = "InvalidTranscriptError";
  }
}

async function extractCompressedAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "48k",
        outputPath,
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    throw new Error("The source audio could not be prepared for transcription.");
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function validateTranscript(
  responseText: string,
  durationSeconds: number,
): TranscriptSegment[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripCodeFence(responseText)) as unknown;
  } catch {
    throw new InvalidTranscriptError("Gemini did not return valid transcript JSON.");
  }
  const parsed = TranscriptSchema.safeParse(decoded);
  if (!parsed.success || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new InvalidTranscriptError();
  }

  let previousStart = -1;
  return parsed.data.segments.map((segment) => {
    if (
      segment.end <= segment.start ||
      segment.end > durationSeconds + 0.5 ||
      segment.start < previousStart
    ) {
      throw new InvalidTranscriptError("Gemini returned out-of-range transcript timestamps.");
    }
    previousStart = segment.start;
    return segment;
  });
}

export async function transcribeVideoAudio(
  inputPath: string,
  audioPath: string,
  durationSeconds: number,
  provider: AIProvider,
  options: AudioTranscriptionOptions = {},
): Promise<TranscriptSegment[]> {
  await (options.runFfmpeg ?? extractCompressedAudio)(inputPath, audioPath);
  const audioStats = await stat(audioPath);
  if (audioStats.size === 0 || audioStats.size > MAX_INLINE_AUDIO_BYTES) {
    throw new Error("The compressed audio exceeds Gemini's inline transcription limit.");
  }

  const prompt = [
    "Transcribe the speech in this auto-body repair video for accurate on-screen subtitles.",
    "Detect the spoken language automatically. If it is Persian, keep the exact spoken Persian; otherwise translate faithfully into concise, natural Persian subtitles.",
    "Do not describe sounds, infer words, or invent speech. If there is no intelligible speech, return an empty segments array.",
    "Split subtitles into short readable phrases. Return source-video timestamps in seconds, including decimals, and no overlapping lines.",
    'Return only valid JSON in this shape: {"segments":[{"start":0.0,"end":1.5,"text":"زیرنویس فارسی"}]}.',
  ].join("\n");
  const response = await provider.generateMultimodal(prompt, [
    {
      label: "Original audio track from the video. Timestamps are relative to the start of the source video.",
      mimeType: "audio/mp3",
      data: await readFile(audioPath),
    },
  ]);
  return validateTranscript(response, durationSeconds);
}