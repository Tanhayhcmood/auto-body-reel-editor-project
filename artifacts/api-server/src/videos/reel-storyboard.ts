import { z } from "zod";
import type { AIProvider } from "../ai/provider";
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

  const response = await provider.generateText(prompt);
  return validateReelStoryboard(response, segments, maxDurationSeconds);
}