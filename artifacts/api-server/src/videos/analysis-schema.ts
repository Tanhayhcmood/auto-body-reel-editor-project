import { z } from "zod";
import type { VideoSegment } from "./segmentation";

export const ALLOWED_SEGMENT_LABELS = [
  "damaged_area",
  "before_repair",
  "repair_process",
  "tools_action",
  "close_up_detail",
  "satisfying_moment",
  "final_result",
  "vehicle_reveal",
  "painting",
  "sanding",
  "polishing",
  "dent_repair",
  "uninteresting",
  "repetitive",
  "blurry",
] as const;

const SegmentAnalysisSchema = z
  .object({
    segment_id: z.string().min(1).max(80),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    summary: z.string().trim().min(1).max(2000),
    visual_events: z.array(z.string().trim().min(1).max(300)).max(24),
    labels: z.array(z.enum(ALLOWED_SEGMENT_LABELS)).max(15),
    quality_score: z.number().finite().min(0).max(1),
    interest_score: z.number().finite().min(0).max(1),
    repair_relevance: z.number().finite().min(0).max(1),
    transformation_value: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((analysis, context) => {
    if (analysis.end <= analysis.start) {
      context.addIssue({
        code: "custom",
        message: "Segment end must be after its start.",
        path: ["end"],
      });
    }
    if (new Set(analysis.labels).size !== analysis.labels.length) {
      context.addIssue({
        code: "custom",
        message: "Segment labels must be unique.",
        path: ["labels"],
      });
    }
  });

const AnalysisEnvelopeSchema = z
  .object({
    segments: z.array(SegmentAnalysisSchema).min(1).max(16),
  })
  .strict();

export type SegmentAnalysis = z.infer<typeof SegmentAnalysisSchema>;

export class InvalidAIResponseError extends Error {
  constructor(message = "Gemini returned an invalid segment analysis.") {
    super(message);
    this.name = "InvalidAIResponseError";
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function validateGeminiAnalysis(
  responseText: string,
  expectedSegments: VideoSegment[],
  videoDuration: number,
): SegmentAnalysis[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripCodeFence(responseText)) as unknown;
  } catch {
    throw new InvalidAIResponseError("Gemini did not return valid JSON.");
  }

  const parsedResponse = AnalysisEnvelopeSchema.safeParse(parsedJson);
  if (!parsedResponse.success) {
    throw new InvalidAIResponseError(
      "Gemini response did not match the required analysis schema.",
    );
  }
  if (
    !Number.isFinite(videoDuration) ||
    videoDuration <= 0 ||
    parsedResponse.data.segments.length !== expectedSegments.length
  ) {
    throw new InvalidAIResponseError(
      "Gemini response did not contain exactly one result per video segment.",
    );
  }

  const responseById = new Map(
    parsedResponse.data.segments.map((segment) => [segment.segment_id, segment]),
  );
  if (responseById.size !== expectedSegments.length) {
    throw new InvalidAIResponseError("Gemini returned duplicate segment IDs.");
  }

  const timestampToleranceSeconds = 0.05;
  return expectedSegments.map((expected) => {
    const analysis = responseById.get(expected.segment_id);
    if (!analysis) {
      throw new InvalidAIResponseError(
        `Gemini omitted analysis for ${expected.segment_id}.`,
      );
    }
    if (
      Math.abs(analysis.start - expected.start) > timestampToleranceSeconds ||
      Math.abs(analysis.end - expected.end) > timestampToleranceSeconds ||
      analysis.start < 0 ||
      analysis.end > videoDuration + timestampToleranceSeconds ||
      analysis.end <= analysis.start
    ) {
      throw new InvalidAIResponseError(
        `Gemini returned invalid timestamps for ${expected.segment_id}.`,
      );
    }

    return {
      ...analysis,
      start: expected.start,
      end: expected.end,
    };
  });
}