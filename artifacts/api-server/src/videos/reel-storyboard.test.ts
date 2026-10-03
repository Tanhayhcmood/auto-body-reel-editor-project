import assert from "node:assert/strict";
import test from "node:test";
import { GeminiAPIError } from "../ai/provider";
import {
  createReelStoryboard,
  InvalidReelStoryboardError,
  validateReelStoryboard,
} from "./reel-storyboard";
import type { SegmentAnalysis } from "./analysis-schema";

function segment(segmentId: string, start: number, end: number): SegmentAnalysis {
  return {
    segment_id: segmentId,
    start,
    end,
    summary: "صاف‌کاری پنل خودرو",
    visual_events: ["تکنسین در حال کار روی پنل است"],
    labels: ["repair_process", "dent_repair"],
    quality_score: 0.9,
    interest_score: 0.8,
    repair_relevance: 0.95,
    transformation_value: 0.6,
  };
}

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook: "قبل از ترمیم",
    cta: "نتیجه را ببینید",
    instagram_caption: "ترمیم بدنه خودرو، مرحله‌به‌مرحله. #خودرو #ترمیم",
    clips: [
      { segment_id: "opening", start: 0.5, end: 2.5 },
      { segment_id: "finish", start: 12, end: 16 },
    ],
    overlays: [{ segment_id: "finish", text: "پرداخت نهایی" }],
    ...overrides,
  });
}

test("validates Gemini's source ranges and returns an ordered edit plan", () => {
  const plan = validateReelStoryboard(
    response(),
    [segment("opening", 0, 5), segment("finish", 10, 18)],
  );

  assert.deepEqual(plan.clips.map((clip) => clip.segment_id), ["opening", "finish"]);
  assert.equal(plan.durationSeconds, 6);
  assert.equal(plan.hook, "قبل از ترمیم");
  assert.equal(plan.overlays[0]?.text, "پرداخت نهایی");
});

test("rejects invented source segments and plans over the duration cap", () => {
  const segments = [segment("opening", 0, 5), segment("finish", 10, 18)];
  assert.throws(
    () => validateReelStoryboard(response({
      clips: [{ segment_id: "not-in-source", start: 0, end: 2 }],
    }), segments),
    InvalidReelStoryboardError,
  );
  assert.throws(
    () => validateReelStoryboard(response({
      clips: [
        { segment_id: "opening", start: 0, end: 5 },
        { segment_id: "finish", start: 10, end: 18 },
      ],
    }), segments, 8),
    InvalidReelStoryboardError,
  );
});

test("asks the configured AI provider for a storyboard and validates its response", async () => {
  let prompt = "";
  const provider = {
    name: "gemini",
    model: "test-model",
    generateText: async (value: string) => {
      prompt = value;
      return response();
    },
    generateMultimodal: async () => "",
  };
  const plan = await createReelStoryboard(
    [segment("opening", 0, 5), segment("finish", 10, 18)],
    provider,
  );

  assert.equal(plan.clips.length, 2);
  assert.match(prompt, /Persian/);
  assert.match(prompt, /source segments/);
});

test("builds a truthful local fallback storyboard after a temporary Gemini outage", async () => {
  const provider = {
    name: "gemini",
    model: "test-model",
    generateText: async () => {
      throw new GeminiAPIError(
        "Gemini API request failed with status 503.",
        "Temporary model overload.",
        503,
      );
    },
    generateMultimodal: async () => "",
  };

  const plan = await createReelStoryboard(
    [
      segment("opening", 0, 5),
      segment("finish", 10, 18),
      { ...segment("noise", 20, 26), labels: ["uninteresting"] },
    ],
    provider,
  );

  assert.equal(plan.usedFallback, true);
  assert.deepEqual(plan.clips.map((clip) => clip.segment_id), ["opening", "finish"]);
  assert.equal(plan.durationSeconds, 13);
  assert.deepEqual(plan.overlays, []);
  assert.match(plan.instagramCaption, /حضوری بررسی شود/);
});