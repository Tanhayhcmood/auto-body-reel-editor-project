import { z } from "zod";
import { GeminiAPIError, type AIProvider } from "../ai/provider";
import type { SegmentAnalysis } from "./analysis-schema";
import type { ReelClip } from "./reel-editor";

const StoryboardSchema = z
  .object({
    hook: z.string().trim().min(2).max(100),
    cta: z.string().trim().min(2).max(120),
    instagram_caption: z.string().trim().min(5).max(2_000),
    clips: z
      .array(
        z
          .object({
            segment_id: z.string().min(1).max(80),
            start: z.number().finite().nonnegative(),
            end: z.number().finite().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    overlays: z
      .array(
        z
          .object({
            segment_id: z.string().min(1).max(80),
            text: z.string().trim().min(1).max(64),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export interface ReelStoryboard {
  hook: string;
  cta: string;
  instagramCaption: string;
  clips: ReelClip[];
  overlays: Array<{ segment_id: string; text: string }>;
  durationSeconds: number;
  usedFallback?: boolean;
}

export class InvalidReelStoryboardError extends Error {
  constructor(message = "Gemini returned an invalid Reel storyboard.") {
    super(message);
    this.name = "InvalidReelStoryboardError";
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function validateReelStoryboard(
  responseText: string,
  segments: SegmentAnalysis[],
  maxDurationSeconds = 30,
): ReelStoryboard {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripCodeFence(responseText)) as unknown;
  } catch {
    throw new InvalidReelStoryboardError("Gemini did not return valid Reel-plan JSON.");
  }

  const parsed = StoryboardSchema.safeParse(decoded);
  if (!parsed.success || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new InvalidReelStoryboardError();
  }

  const segmentsById = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const seen = new Set<string>();
  const clips: ReelClip[] = [];
  let durationSeconds = 0;

  for (const clip of parsed.data.clips) {
    const segment = segmentsById.get(clip.segment_id);
    if (
      !segment ||
      seen.has(clip.segment_id) ||
      clip.start < segment.start - 0.05 ||
      clip.end > segment.end + 0.05 ||
      clip.end <= clip.start ||
      clip.end - clip.start < 0.7
    ) {
      throw new InvalidReelStoryboardError(
        "Gemini selected a clip outside the analyzed source segments.",
      );
    }
    seen.add(clip.segment_id);
    const start = Math.max(segment.start, clip.start);
    const end = Math.min(segment.end, clip.end);
    clips.push({ segment_id: clip.segment_id, start, end });
    durationSeconds += end - start;
  }

  if (durationSeconds > maxDurationSeconds || durationSeconds <= 0) {
    throw new InvalidReelStoryboardError("Gemini selected a Reel outside the duration limit.");
  }

  const overlays = parsed.data.overlays.filter((overlay) => seen.has(overlay.segment_id));
  return {
    hook: parsed.data.hook,
    cta: parsed.data.cta,
    instagramCaption: parsed.data.instagram_caption,
    clips,
    overlays,
    durationSeconds: Number(durationSeconds.toFixed(3)),
  };
}

function createFallbackStoryboard(
  segments: SegmentAnalysis[],
  maxDurationSeconds: number,
): ReelStoryboard | undefined {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1) {
    return undefined;
  }

  const excludedLabels = new Set(["blurry", "repetitive", "uninteresting"]);
  const candidates = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.start >= 0 &&
        segment.end - segment.start >= 1 &&
        segment.repair_relevance >= 0.35 &&
        segment.quality_score >= 0.25 &&
        !segment.labels.some((label) => excludedLabels.has(label)),
    )
    .map((segment) => ({
      segment,
      score:
        segment.repair_relevance * 0.55 +
        segment.quality_score * 0.2 +
        segment.interest_score * 0.15 +
        segment.transformation_value * 0.1,
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.segment.start - right.segment.start,
    );

  const clips: ReelClip[] = [];
  let remainingSeconds = maxDurationSeconds;
  for (const { segment } of candidates) {
    if (clips.length >= 12 || remainingSeconds < 1) break;
    const duration = Math.min(segment.end - segment.start, remainingSeconds);
    if (duration < 1) continue;
    clips.push({
      segment_id: segment.segment_id,
      start: segment.start,
      end: Number((segment.start + duration).toFixed(4)),
    });
    remainingSeconds -= duration;
  }

  if (clips.length === 0) return undefined;
  clips.sort((left, right) => left.start - right.start);

  return {
    hook: "نگاهی به مراحل ترمیم بدنه",
    cta: "برای مشاورهٔ ترمیم پیام بده",
    instagramCaption:
      "مراحل قابل‌مشاهدهٔ ترمیم بدنهٔ خودرو؛ برای ارزیابی دقیق، خودرو باید حضوری بررسی شود.\n" +
      "#صافکاری #تعمیر_بدنه #خودرو",
    clips,
    overlays: [],
    durationSeconds: Number(
      clips.reduce((sum, clip) => sum + clip.end - clip.start, 0).toFixed(3),
    ),
    usedFallback: true,
  };
}

export async function createReelStoryboard(
  segments: SegmentAnalysis[],
  provider: AIProvider,
  maxDurationSeconds = 30,
): Promise<ReelStoryboard> {
  if (segments.length === 0) {
    throw new InvalidReelStoryboardError("No analyzed segments are available for editing.");
  }

  const prompt = [
    "You are the video editor for a Persian auto-body repair Instagram Reels studio.",
    "Create a real editorial plan from the supplied Gemini visual analysis. Do not claim any repair result, tool, action, or before/after state that the segment evidence does not show.",
    "Write the hook, call to action, overlays, and Instagram caption in natural Persian. Keep the original video audio; do not request music.",
    "Choose source-time clips only from the supplied segments. Use a strong visible opening, then the most useful repair moments, and a clear final result only if it is actually visible. Reorder clips only when the story remains truthful.",
    `The final Reel must be no longer than ${maxDurationSeconds} seconds. Each clip must be at least 0.7 seconds.`,
    "Add short Persian on-screen overlays for selected repair moments. Do not put spoken dialogue in overlays; that will be transcribed separately.",
    "Return only valid JSON with exactly these keys: hook, cta, instagram_caption, clips, overlays.",
    'clips must be an array of {"segment_id":"exact source id","start":0,"end":1}.',
    'overlays must be an array of {"segment_id":"exact source id","text":"short Persian overlay"}.',
    "The Instagram caption must be concise, evidence-based, and end with a few relevant Persian hashtags.",
    "Analyzed source segments:",
    JSON.stringify(
      segments.map(
        ({
          segment_id,
          start,
          end,
          summary,
          visual_events,
          labels,
          quality_score,
          interest_score,
          repair_relevance,
          transformation_value,
        }) => ({
          segment_id,
          start,
          end,
          summary,
          visual_events,
          labels,
          quality_score,
          interest_score,
          repair_relevance,
          transformation_value,
        }),
      ),
    ),
  ].join("\n\n");

  try {
    const response = await provider.generateText(prompt);
    return validateReelStoryboard(response, segments, maxDurationSeconds);
  } catch (error) {
    if (error instanceof GeminiAPIError && error.retryable) {
      const fallback = createFallbackStoryboard(segments, maxDurationSeconds);
      if (fallback) return fallback;
    }
    throw error;
  }
}