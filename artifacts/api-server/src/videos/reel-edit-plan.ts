import { z } from "zod";
import type { AIProvider } from "../ai/provider";
import type { VideoAnalysisResult } from "./video-analysis";
import type { SegmentAnalysis } from "./analysis-schema";

export const MAX_REEL_CLIPS = 12;
export const MAX_REEL_DURATION_SECONDS = 60;
export const MAX_CLIP_DURATION_SECONDS = 15;
export const MIN_CLIP_DURATION_SECONDS = 0.5;

const ReelClipSchema = z
  .object({
    segment_id: z.string().trim().min(1).max(80),
    source_start_seconds: z.number().finite().nonnegative(),
    source_end_seconds: z.number().finite().positive(),
    order: z.number().int().min(1).max(MAX_REEL_CLIPS),
    selection_reason: z.string().trim().min(1).max(300),
    caption_text: z.string().trim().min(1).max(120),
    caption_start_seconds: z.number().finite().nonnegative(),
    caption_end_seconds: z.number().finite().positive(),
    reframe_x: z.number().finite().min(0).max(1),
    reframe_y: z.number().finite().min(0).max(1),
  })
  .strict();

const ReelEditPlanSchema = z
  .object({
    story_arc: z.string().trim().min(1).max(500),
    hook_text: z.string().trim().min(1).max(120),
    hook_duration_seconds: z.number().finite().positive(),
    clips: z.array(ReelClipSchema).min(1).max(MAX_REEL_CLIPS),
  })
  .strict();

export type ReelEditClip = z.infer<typeof ReelClipSchema>;
export type ReelEditPlan = z.infer<typeof ReelEditPlanSchema>;

export class InvalidReelPlanError extends Error {
  constructor(message = "Gemini returned an invalid Reel edit plan.") {
    super(message);
    this.name = "InvalidReelPlanError";
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function containsPersianOrArabicScript(value: string): boolean {
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(value);
}

export function buildReelEditPrompt(analysis: VideoAnalysisResult): string {
  const evidence = analysis.segments.map(
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
  );

  return `Create an original vertical Reel edit from this analyzed auto-body-repair footage.

Use only the supplied segment evidence. Do not invent speech, actions, damage, tools, materials, vehicle details, or results. You may reorder selected moments to create a clear story, but every source timestamp must remain inside its segment. Choose the strongest immediately understandable visual moment as the opening hook. Do not apply a standard before/process/after template unless the evidence supports that story.

Return a concise story arc and one chosen hook in natural Persian. Each selected clip must have one short, accurate Persian on-screen caption. These are editorial captions, not a transcript of unheard dialogue. Select only useful moments; choose the clip count, clip order, source in/out points, caption timing, and crop focus from the supplied evidence.

The output is a 9:16 MP4. reframe_x and reframe_y are normalized crop positions from 0 (left/top) to 1 (right/bottom). The opening hook begins at the start of the first clip; hook_duration_seconds must fit inside that clip. Clip source times are seconds in the original video. Caption times are seconds relative to the beginning of their selected clip.

Constraints: choose 1-${MAX_REEL_CLIPS} distinct segments, use each segment at most once, keep each clip between ${MIN_CLIP_DURATION_SECONDS} and ${MAX_CLIP_DURATION_SECONDS} seconds, and keep the total edit at or below ${MAX_REEL_DURATION_SECONDS} seconds. Every caption and the hook must be in Persian. Caption timing must fit inside its clip. Prefer a crop that keeps the relevant vehicle area or action visible; use the center only when the evidence does not support another focus.

Return only JSON matching this exact shape, with no markdown or extra keys:
{"story_arc":"...","hook_text":"...","hook_duration_seconds":2.5,"clips":[{"segment_id":"segment-001","source_start_seconds":1.2,"source_end_seconds":4.7,"order":1,"selection_reason":"...","caption_text":"...","caption_start_seconds":0.3,"caption_end_seconds":3.2,"reframe_x":0.5,"reframe_y":0.5}]}

Video duration: ${analysis.duration_seconds} seconds.
Analyzed segments, with exact source ranges and visual evidence:
${JSON.stringify(evidence, null, 2)}`;
}

export function validateReelEditPlan(
  responseText: string,
  analyzedSegments: SegmentAnalysis[],
  videoDuration: number,
): ReelEditPlan {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripCodeFence(responseText)) as unknown;
  } catch {
    throw new InvalidReelPlanError("Gemini did not return valid Reel-plan JSON.");
  }

  const parsed = ReelEditPlanSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InvalidReelPlanError(
      "Gemini's Reel plan did not match the required schema.",
    );
  }
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    throw new InvalidReelPlanError("The source video duration is invalid.");
  }

  const segmentsById = new Map(
    analyzedSegments.map((segment) => [segment.segment_id, segment]),
  );
  if (segmentsById.size !== analyzedSegments.length) {
    throw new InvalidReelPlanError("The analyzed video contains duplicate segment IDs.");
  }
  if (
    !containsPersianOrArabicScript(parsed.data.hook_text) ||
    parsed.data.clips.some(
      (clip) => !containsPersianOrArabicScript(clip.caption_text),
    )
  ) {
    throw new InvalidReelPlanError(
      "Gemini's hook and clip captions must be written in Persian.",
    );
  }

  const clipsByOrder = [...parsed.data.clips].sort(
    (left, right) => left.order - right.order,
  );
  const seenSegments = new Set<string>();
  let totalDuration = 0;
  const boundaryToleranceSeconds = 0.05;

  for (const [index, clip] of clipsByOrder.entries()) {
    const expectedSegment = segmentsById.get(clip.segment_id);
    if (!expectedSegment || seenSegments.has(clip.segment_id)) {
      throw new InvalidReelPlanError(
        "Gemini selected a missing or repeated source segment.",
      );
    }
    seenSegments.add(clip.segment_id);

    if (clip.order !== index + 1) {
      throw new InvalidReelPlanError(
        "Reel clip order must be unique and start at 1 without gaps.",
      );
    }

    const clipDuration = clip.source_end_seconds - clip.source_start_seconds;
    if (
      clip.source_start_seconds < expectedSegment.start - boundaryToleranceSeconds ||
      clip.source_end_seconds > expectedSegment.end + boundaryToleranceSeconds ||
      clip.source_end_seconds > videoDuration + boundaryToleranceSeconds ||
      clip.source_end_seconds <= clip.source_start_seconds ||
      clipDuration < MIN_CLIP_DURATION_SECONDS ||
      clipDuration > MAX_CLIP_DURATION_SECONDS
    ) {
      throw new InvalidReelPlanError(
        `Gemini returned invalid source timestamps for ${clip.segment_id}.`,
      );
    }
    if (
      clip.caption_start_seconds >= clip.caption_end_seconds ||
      clip.caption_end_seconds > clipDuration + boundaryToleranceSeconds
    ) {
      throw new InvalidReelPlanError(
        `Gemini returned invalid caption timestamps for ${clip.segment_id}.`,
      );
    }

    totalDuration += clipDuration;
  }

  if (
    parsed.data.hook_duration_seconds < MIN_CLIP_DURATION_SECONDS ||
    parsed.data.hook_duration_seconds >
      clipsByOrder[0]!.source_end_seconds -
        clipsByOrder[0]!.source_start_seconds +
        boundaryToleranceSeconds
  ) {
    throw new InvalidReelPlanError(
      "Gemini's hook timing does not fit inside the opening clip.",
    );
  }
  if (totalDuration > MAX_REEL_DURATION_SECONDS) {
    throw new InvalidReelPlanError(
      `The selected clips exceed ${MAX_REEL_DURATION_SECONDS} seconds.`,
    );
  }

  return { ...parsed.data, clips: clipsByOrder };
}

export async function createReelEditPlan(
  analysis: VideoAnalysisResult,
  provider: AIProvider,
): Promise<ReelEditPlan> {
  const responseText = await provider.generateJson(buildReelEditPrompt(analysis));
  return validateReelEditPlan(
    responseText,
    analysis.segments,
    analysis.duration_seconds,
  );
}